const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'Intercom Tickets Middleware',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Main endpoint - Tickets v2 to Intercom
app.post('/tickets-to-intercom', async (req, res) => {
  try {
    // Get Intercom credentials from headers
    const intercomToken = req.headers['authorization']?.replace('Bearer ', '');
    const ticketTypeId = req.headers['x-ticket-type-id'];

    if (!intercomToken || !ticketTypeId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required headers: Authorization and X-Ticket-Type-Id'
      });
    }

    // Log incoming data for debugging
    console.log('=== Received Ticket ===');
    console.log('Ticket Type ID:', ticketTypeId);
    console.log('Data:', JSON.stringify(req.body, null, 2));

    // Extract ticket data from Tickets v2
    // Tickets v2 sends: guild_id, user_id, ticket_id, ticket_channel_id, is_new_ticket, form_data
    const {
      guild_id,
      user_id,
      ticket_id,
      ticket_channel_id,
      is_new_ticket,
      form_data,
      // These might not be included:
      username,
      subject,
      content,
      panel_name,
      opened_at,
      user_email
    } = req.body;

    // Step 1: Find or create contact
    let contactId = null;
    
    try {
      // Search for existing contact
      console.log('Searching for contact with Discord ID:', user_id);
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

      if (searchResponse.data.data && searchResponse.data.data.length > 0) {
        contactId = searchResponse.data.data[0].id;
        console.log('Found existing contact:', contactId);
      } else {
        // Create new contact
        console.log('Creating new contact...');
        const createResponse = await axios.post(
          'https://api.intercom.io/contacts',
          {
            external_id: user_id,
            name: username || `Discord User ${user_id}`,
            ...(user_email && { email: user_email })
            // Removed custom_attributes - they need to be created first in Intercom
          },
          {
            headers: {
              'Authorization': `Bearer ${intercomToken}`,
              'Content-Type': 'application/json',
              'Intercom-Version': '2.14'
            }
          }
        );
        contactId = createResponse.data.id;
        console.log('Created new contact:', contactId);
      }
    } catch (contactError) {
      console.error('Contact error:', contactError.response?.data || contactError.message);
      // Continue anyway - we'll use external_id
    }

    // Step 2: Prepare ticket description
    let ticketDescription = content || 'Ticket opened from Discord';
    
    // Add form data if present (form_data is an object with question: answer pairs)
    if (form_data && typeof form_data === 'object' && Object.keys(form_data).length > 0) {
      ticketDescription += '\n\n**Form Responses:**\n';
      Object.entries(form_data).forEach(([question, answer]) => {
        ticketDescription += `• ${question}: ${answer}\n`;
      });
    }
    
    ticketDescription += `\n\n---\n`;
    ticketDescription += `*Created via Discord Tickets v2*\n`;
    ticketDescription += `Guild ID: ${guild_id}\n`;
    ticketDescription += `Channel ID: ${ticket_channel_id || 'Unknown'}\n`;
    ticketDescription += `Discord User ID: ${user_id}\n`;
    ticketDescription += `Ticket ID: ${ticket_id}`;

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

    console.log('Creating Intercom ticket...');
    console.log('Payload:', JSON.stringify(ticketPayload, null, 2));

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

    console.log('✓ Ticket created successfully');
    console.log('Job ID:', ticketResponse.data.id);
    console.log('Status:', ticketResponse.data.status);

    // Step 4: Return response for Tickets v2 placeholders
    res.json({
      success: true,
      intercom_job_id: ticketResponse.data.id,
      intercom_status: ticketResponse.data.status,
      intercom_job_url: ticketResponse.data.url,
      ticket: {
        id: ticket_id,
        discord_id: ticket_id,
        status: 'created_in_intercom',
        panel: panel_name
      },
      user: {
        username: username,
        discord_id: user_id,
        intercom_contact_id: contactId
      },
      message: '✅ Ticket created successfully in Intercom!'
    });

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Message:', error.message);
    console.error('Response:', error.response?.data);
    console.error('Status:', error.response?.status);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      details: error.response?.data,
      ticket: {
        status: 'failed'
      },
      message: '❌ Failed to create ticket in Intercom'
    });
  }
});

// Secret validation endpoint
app.post('/validate-secrets', async (req, res) => {
  try {
    const { intercom_token, ticket_type_id } = req.body;

    console.log('Validating secrets...');

    if (!intercom_token || !ticket_type_id) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Missing required secrets: intercom_token and ticket_type_id' 
      });
    }

    // Validate Intercom token by calling /me
    const meResponse = await axios.get('https://api.intercom.io/me', {
      headers: {
        'Authorization': `Bearer ${intercom_token}`,
        'Intercom-Version': '2.11'
      }
    });

    console.log('Token valid for workspace:', meResponse.data.name);

    // Validate ticket type exists
    const ticketTypeResponse = await axios.get(
      `https://api.intercom.io/ticket_types/${ticket_type_id}`,
      {
        headers: {
          'Authorization': `Bearer ${intercom_token}`,
          'Intercom-Version': '2.11'
        }
      }
    );

    console.log('Ticket type valid:', ticketTypeResponse.data.name);

    res.status(200).json({ 
      valid: true,
      workspace: meResponse.data.name,
      ticket_type: ticketTypeResponse.data.name
    });

  } catch (error) {
    console.error('Validation error:', error.response?.data || error.message);
    res.status(400).json({ 
      valid: false, 
      error: error.response?.data?.errors?.[0]?.message || 'Invalid credentials'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    available_endpoints: [
      'GET / - Health check',
      'GET /health - Health check',
      'POST /tickets-to-intercom - Create ticket',
      'POST /validate-secrets - Validate credentials'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware server running on port ${PORT}`);
  console.log(`📡 Ready to receive tickets from Discord Tickets v2`);
});
