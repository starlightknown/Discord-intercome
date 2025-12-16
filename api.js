const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'Intercom Tickets Middleware',
    version: '1.1.0 - API 2.14'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', api_version: '2.14' });
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
    const {
      guild_id,
      user_id,
      ticket_id,
      ticket_channel_id,
      is_new_ticket,
      form_data,
      user_email, // Tickets v2 might send this
      email       // or this
    } = req.body;

    // Get email from body or form data
    let userEmail = user_email || email;
    
    // If not in body, check form data with MORE field name variations
    if (!userEmail && form_data && typeof form_data === 'object') {
      const emailFields = [
        'email', 'Email', 'EMAIL',
        'Email Address', 'email address', 'EMAIL ADDRESS',
        'Email ID', 'email id', 'EMAIL ID', // Added Email ID
        'E-mail', 'e-mail', 'E-Mail',
        'userEmail', 'user_email',
        'contact_email', 'Contact Email'
      ];
      
      for (const field of emailFields) {
        if (form_data[field]) {
          userEmail = form_data[field];
          console.log(`✓ Found email in form field "${field}":`, userEmail);
          break;
        }
      }
    }

    console.log('User email:', userEmail || 'Not provided');

    // Step 1: Find or create contact using email
    let contactId = null;
    
    try {
      if (userEmail) {
        // Search by email first
        console.log('Searching for contact with email:', userEmail);
        const searchResponse = await axios.post(
          'https://api.intercom.io/contacts/search',
          {
            query: {
              field: 'email',
              operator: '=',
              value: userEmail
            }
          },
          {
            headers: {
              'Authorization': `Bearer ${intercomToken}`,
              'Content-Type': 'application/json',
              'Intercom-Version': '2.14'
            }
          }
        );

        if (searchResponse.data.data && searchResponse.data.data.length > 0) {
          // Contact exists! Use it
          contactId = searchResponse.data.data[0].id;
          console.log('✓ Found existing contact by email:', contactId);
          console.log('  Name:', searchResponse.data.data[0].name);
        } else {
          // Create new contact with email
          console.log('✗ No contact found, creating new one with email...');
          const createResponse = await axios.post(
            'https://api.intercom.io/contacts',
            {
              email: userEmail,
              external_id: user_id,
              name: `Discord User ${user_id}`
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
          console.log('✓ Created new contact with email:', contactId);
        }
      } else {
        // No email provided - fallback to Discord ID
        console.log('⚠️  No email provided, using Discord ID:', user_id);
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
              'Intercom-Version': '2.14'
            }
          }
        );

        if (searchResponse.data.data && searchResponse.data.data.length > 0) {
          contactId = searchResponse.data.data[0].id;
          console.log('✓ Found existing contact by Discord ID:', contactId);
        } else {
          console.log('✗ Creating new contact without email...');
          const createResponse = await axios.post(
            'https://api.intercom.io/contacts',
            {
              external_id: user_id,
              name: `Discord User ${user_id}`
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
          console.log('✓ Created new contact without email:', contactId);
        }
      }
    } catch (contactError) {
      console.error('Contact error:', contactError.response?.data || contactError.message);
      // Continue anyway - we'll use external_id or email in ticket creation
    }

    // Step 2: Prepare ticket description
    let ticketDescription = 'Ticket opened from Discord';
    
    // Add form data if present
    if (form_data && typeof form_data === 'object' && Object.keys(form_data).length > 0) {
      ticketDescription += '\n\n**Form Responses:**\n';
      Object.entries(form_data).forEach(([question, answer]) => {
        ticketDescription += `• ${question}: ${answer}\n`;
      });
    }
    
    ticketDescription += `\n\n---\n`;
    ticketDescription += `*Created via Discord Tickets v2*\n`;
    ticketDescription += `Guild ID: ${guild_id}\n`;
    ticketDescription += `Channel ID: ${ticket_channel_id}\n`;
    ticketDescription += `Discord User ID: ${user_id}\n`;
    ticketDescription += `Ticket ID: ${ticket_id}`;

    // Step 3: Create ticket in Intercom
    const ticketPayload = {
      ticket_type_id: ticketTypeId,
      contacts: contactId 
        ? [{ id: contactId }]
        : [{ external_id: user_id }],
      ticket_attributes: {
        _default_title_: `Discord Ticket #${ticket_id}`,
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
          'Intercom-Version': '2.14'
        }
      }
    );

    console.log('✓ Ticket created successfully');
    console.log('Job ID:', ticketResponse.data.id);
    console.log('Status:', ticketResponse.data.status);

    // Step 4: Return response for Tickets v2 placeholders
    const responsePayload = {
      intercom_job_id: String(ticketResponse.data.id),
      intercom_status: ticketResponse.data.status,
      ticket: {
        status: 'created_in_intercom'
      },
      message: 'Ticket created successfully in Intercom!'
    };

    console.log('=== SENDING RESPONSE TO TICKETS V2 ===');
    console.log(JSON.stringify(responsePayload, null, 2));
    console.log('=====================================');
    
    res.status(200).json(responsePayload);

    // Register this ticket channel with Discord bot for message monitoring
    const discordBotUrl = process.env.DISCORD_BOT_URL || 'http://localhost:3001';
    
    try {
      await axios.post(`${discordBotUrl}/register-ticket`, {
        discord_channel_id: ticket_channel_id,
        intercom_ticket_id: ticketResponse.data.id,
        intercom_contact_id: contactId,
        user_id: user_id
      });
      console.log('✓ Ticket registered with Discord bot for two-way sync');
    } catch (error) {
      console.error('⚠️  Failed to register with Discord bot:', error.message);
      // Non-critical error, continue anyway
    }

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
      message: 'Failed to create ticket in Intercom'
    });
  }
});

// Close ticket endpoint
app.post('/close-ticket', async (req, res) => {
  try {
    const intercomToken = req.headers['authorization']?.replace('Bearer ', '');
    const { ticket_id, user_id, closed_by } = req.body;

    console.log('=== Close Ticket Request ===');
    console.log('Discord Ticket ID:', ticket_id);
    console.log('User ID:', user_id);
    console.log('Closed by:', closed_by);

    // Unfortunately, we don't have a direct mapping from Discord ticket_id to Intercom ticket_id
    // We would need to search for the ticket or store the mapping
    
    // Search for tickets by contact
    const searchResponse = await axios.post(
      'https://api.intercom.io/tickets/search',
      {
        query: {
          operator: 'AND',
          value: [
            {
              field: 'contact_ids',
              operator: '=',
              value: user_id
            },
            {
              field: 'open',
              operator: '=',
              value: true
            }
          ]
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${intercomToken}`,
          'Content-Type': 'application/json',
          'Intercom-Version': '2.14'
        }
      }
    );

    // Find ticket with matching Discord ID in description
    const matchingTicket = searchResponse.data.tickets?.find(ticket => 
      ticket.ticket_attributes?._default_description_?.includes(`Ticket ID: ${ticket_id}`)
    );

    if (matchingTicket) {
      // Close the ticket by updating its state
      await axios.put(
        `https://api.intercom.io/tickets/${matchingTicket.id}`,
        {
          ticket_state_id: matchingTicket.ticket_type.ticket_states.data.find(
            state => state.category === 'resolved'
          )?.id
        },
        {
          headers: {
            'Authorization': `Bearer ${intercomToken}`,
            'Content-Type': 'application/json',
            'Intercom-Version': '2.14'
          }
        }
      );

      console.log('✓ Intercom ticket closed:', matchingTicket.id);
      
      res.json({
        success: true,
        message: 'Ticket closed in Intercom',
        intercom_ticket_id: matchingTicket.id
      });
    } else {
      console.log('⚠️ No matching Intercom ticket found');
      res.json({
        success: false,
        message: 'No matching Intercom ticket found'
      });
    }

  } catch (error) {
    console.error('Error closing ticket:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.message
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
        'Intercom-Version': '2.14'
      }
    });

    console.log('Token valid for workspace:', meResponse.data.name);

    // Validate ticket type exists
    const ticketTypeResponse = await axios.get(
      `https://api.intercom.io/ticket_types/${ticket_type_id}`,
      {
        headers: {
          'Authorization': `Bearer ${intercom_token}`,
          'Intercom-Version': '2.14'
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

// Intercom webhook endpoint for ticket replies
app.post('/intercom-webhook', async (req, res) => {
  try {
    console.log('=== Intercom Webhook Received ===');
    console.log('Topic:', req.body.topic);
    
    // Respond immediately to Intercom (required)
    res.status(200).json({ received: true });

    const { topic, data } = req.body;

    // Only handle ticket reply events from admins
    if (topic === 'conversation_part.tag.created' || topic === 'conversation_part.redacted') {
      console.log('Ignoring non-reply event');
      return;
    }

    // Optionally log minimal webhook details in debug mode to avoid leaking PII / large payloads
    if (process.env.INTERCOM_WEBHOOK_DEBUG === 'true') {
      console.log('Intercom webhook metadata:', {
        topic,
        conversationId: data?.item?.conversation?.id,
        conversationPartId: data?.item?.conversation_part?.id,
      });
    }

    // Extract ticket part and ticket info
    const conversationPart = data?.item?.conversation_part;
    const conversation = data?.item?.conversation;

    if (!conversationPart || !conversation) {
      console.log('No conversation part or conversation found');
      return;
    }

    // Only forward admin/teammate replies, not user messages
    if (conversationPart.author?.type !== 'admin' && conversationPart.author?.type !== 'bot') {
      console.log('Ignoring non-admin message');
      return;
    }

    console.log('Processing admin reply...');
    console.log('Author:', conversationPart.author?.name);
    console.log('Message:', conversationPart.body);

    // Try to extract Discord channel ID from conversation
    // We need to search for the ticket to get the description
    const intercomToken = req.headers['x-intercom-token'] || process.env.INTERCOM_TOKEN;
    
    if (!intercomToken) {
      console.error('No Intercom token available for webhook');
      return;
    }

    // Get the full ticket details to find Discord channel ID
    let ticketDetails;
    try {
      const ticketResponse = await axios.get(
        `https://api.intercom.io/tickets/${conversation.id}`,
        {
          headers: {
            'Authorization': `Bearer ${intercomToken}`,
            'Intercom-Version': '2.14'
          }
        }
      );
      ticketDetails = ticketResponse.data;
    } catch (error) {
      console.error('Error fetching ticket details:', error.response?.data || error.message);
      return;
    }

    // Extract Discord channel ID from ticket description
    const description = ticketDetails.ticket_attributes?._default_description_ || '';
    const channelMatch = description.match(/Channel ID: (\d+)/);
    
    if (!channelMatch) {
      console.error('No Discord channel ID found in ticket description');
      return;
    }

    const discordChannelId = channelMatch[1];
    console.log('Discord Channel ID:', discordChannelId);

    // Get admin name
    const adminName = conversationPart.author?.name || 'Support Agent';

    // Send to Discord via Discord Bot API endpoint
    const discordBotUrl = process.env.DISCORD_BOT_URL || 'http://localhost:3001';
    
    try {
      await axios.post(`${discordBotUrl}/send-to-discord`, {
        channel_id: discordChannelId,
        message: conversationPart.body,
        author_name: adminName
      });
      console.log('✓ Message sent to Discord');
    } catch (error) {
      console.error('Error sending to Discord:', error.message);
    }

  } catch (error) {
    console.error('Webhook processing error:', error);
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
      'POST /intercom-webhook - Intercom webhook'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware server running on port ${PORT}`);
  console.log(`📡 Using Intercom API version 2.14`);
  console.log(`✅ Ready to receive tickets from Discord Tickets v2`);
});
