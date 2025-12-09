const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

app.post('/tickets-to-intercom', async (req, res) => {
  try {
    // Get Intercom credentials from headers
    const intercomToken = req.headers['authorization']?.replace('Bearer ', '');
    const ticketTypeId = req.headers['x-ticket-type-id'];

    // Log incoming data for debugging
    console.log('Received ticket data:', req.body);

    // Extract ticket data from Tickets v2
    const {
      user_id,
      username,
      ticket_id,
      subject,
      content,
      panel_name,
      opened_at,
      user_email, // If available
      form_data // Custom form fields if any
    } = req.body;

    // Step 1: Create or get contact in Intercom
    let contactId;
    try {
      // Try to find existing contact by Discord ID
      const searchResponse = await axios.post(
        'https://api.intercom.io/contacts/search',
        {
          query: {
            field: 'external_id',
            operator: '=',
            value: user_id
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${intercomToken}`,
            'Content-Type': 'application/json',
            'Intercom-Version': '2.11'
          }
        }
      );

      if (searchResponse.data.data.length > 0) {
        contactId = searchResponse.data.data[0].id;
      } else {
        // Create new contact
        const createResponse = await axios.post(
          'https://api.intercom.io/contacts',
          {
            external_id: user_id,
            name: username,
            custom_attributes: {
              discord_username: username,
              source: 'discord_tickets_v2'
            }
          },
          {
            headers: {
              'Authorization': `Bearer ${intercomToken}`,
              'Content-Type': 'application/json',
              'Intercom-Version': '2.11'
            }
          }
        );
        contactId = createResponse.data.id;
      }
    } catch (error) {
      console.error('Error with contact:', error.response?.data);
      // Continue anyway, we'll use external_id in ticket creation
    }

    // Step 2: Prepare ticket description
    let ticketDescription = content || 'No description provided';
    
    if (form_data && form_data.length > 0) {
      ticketDescription += '\n\n**Form Responses:**\n';
      form_data.forEach(field => {
        ticketDescription += `• ${field.label}: ${field.value}\n`;
      });
    }
    
    ticketDescription += `\n\n*Ticket opened via Discord Tickets v2*\n`;
    ticketDescription += `Panel: ${panel_name}\n`;
    ticketDescription += `Discord User ID: ${user_id}`;

    // Step 3: Create ticket in Intercom
    const ticketPayload = {
      ticket_type_id: ticketTypeId,
      contacts: contactId 
        ? [{ id: contactId }]
        : [{ external_id: user_id }],
      ticket_attributes: {
        _default_title_: subject || `Discord Ticket #${ticket_id}`,
        _default_description_: ticketDescription
      }
    };

    console.log('Creating Intercom ticket with payload:', ticketPayload);

    const ticketResponse = await axios.post(
      'https://api.intercom.io/tickets/enqueue',
      ticketPayload,
      {
        headers: {
          'Authorization': `Bearer ${intercomToken}`,
          'Content-Type': 'application/json',
          'Intercom-Version': '2.11'
        }
      }
    );

    console.log('Intercom response:', ticketResponse.data);

    // Step 4: Return response for Tickets v2 placeholders
    res.json({
      success: true,
      intercom_job_id: ticketResponse.data.id,
      intercom_status: ticketResponse.data.status,
      ticket: {
        id: ticket_id,
        discord_id: ticket_id,
        status: 'created_in_intercom'
      },
      user: {
        username: username,
        discord_id: user_id
      },
      message: 'Ticket created successfully in Intercom'
    });

  } catch (error) {
    console.error('Error creating ticket:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data,
      ticket: {
        status: 'failed'
      }
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Secret validation endpoint
app.post('/validate-secrets', async (req, res) => {
  try {
    const { intercom_token, ticket_type_id } = req.body;

    if (!intercom_token || !ticket_type_id) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Missing required secrets' 
      });
    }

    // Validate Intercom token
    const meResponse = await axios.get('https://api.intercom.io/me', {
      headers: {
        'Authorization': `Bearer ${intercom_token}`,
        'Intercom-Version': '2.11'
      }
    });

    // Validate ticket type exists
    await axios.get(`https://api.intercom.io/ticket_types/${ticket_type_id}`, {
      headers: {
        'Authorization': `Bearer ${intercom_token}`,
        'Intercom-Version': '2.11'
      }
    });

    res.status(200).json({ 
      valid: true,
      workspace: meResponse.data.name
    });

  } catch (error) {
    res.status(400).json({ 
      valid: false, 
      error: error.response?.data?.errors?.[0]?.message || 'Invalid credentials'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});
