const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'Intercom Tickets Middleware',
    version: '1.4.0 - API 2.14 - Two-Way Sync with Proxy'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', api_version: '2.14' });
});

// WEBHOOK ENDPOINT - Intercom to Discord
app.post('/intercom-webhook', async (req, res) => {
  try {
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Topic:', req.body.topic);
    
    // Respond immediately to Intercom (MUST be first)
    res.status(200).json({ received: true });

    const { topic, data } = req.body;

    // Handle test/ping
    if (!topic || topic === 'ping') {
      console.log('✓ Webhook test received');
      return;
    }

    // Handle both ticket and conversation admin replies
    if (topic !== 'ticket.admin.replied' && topic !== 'conversation.admin.replied') {
      console.log('Ignoring topic:', topic);
      return;
    }

    console.log('Processing admin reply...');

    // Get the ticket/conversation and reply details
    const ticket = data?.item?.ticket || data?.item?.conversation;
    const ticketPart = data?.item?.ticket_part || data?.item?.conversation_part;

    if (!ticket || !ticketPart) {
      console.log('No ticket/conversation or part found');
      return;
    }

    // Skip non-admin messages
    if (ticketPart.author?.type !== 'admin' && ticketPart.author?.type !== 'bot') {
      console.log('Ignoring non-admin message');
      return;
    }

    // Get admin name and message
    const adminName = ticketPart.author?.name || 'Support Agent';
    const message = stripHtml(ticketPart.body);

    console.log('Admin:', adminName);
    console.log('Message:', message);

    // Extract Discord channel ID from ticket description
    const description = ticket.ticket_attributes?._default_description_ || '';
    const channelMatch = description.match(/Channel ID: (\d+)/);
    
    if (!channelMatch) {
      console.error('❌ No Discord channel ID found in ticket description');
      return;
    }

    const discordChannelId = channelMatch[1];
    console.log('Discord Channel ID:', discordChannelId);

    // Send to Discord bot
    const discordBotUrl = process.env.DISCORD_BOT_URL || 'http://localhost:3001';
    
    try {
      await axios.post(`${discordBotUrl}/send-to-discord`, {
        channel_id: discordChannelId,
        message: message,
        author_name: adminName
      });
      console.log('✅ Message sent to Discord');
    } catch (error) {
      console.error('❌ Error sending to Discord:', error.message);
    }

  } catch (error) {
    console.error('❌ Webhook processing error:', error.message);
  }
});

// Main endpoint - Tickets v2 to Intercom
app.post('/tickets-to-intercom', async (req, res) => {
  try {
    const intercomToken = req.headers['authorization']?.replace('Bearer ', '');
    const ticketTypeId = req.headers['x-ticket-type-id'];

    if (!intercomToken || !ticketTypeId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required headers: Authorization and X-Ticket-Type-Id'
      });
    }

    console.log('=== Received Ticket ===');
    console.log('Ticket Type ID:', ticketTypeId);
    console.log('Data:', JSON.stringify(req.body, null, 2));

    const {
      guild_id,
      user_id,
      ticket_id,
      ticket_channel_id,
      is_new_ticket,
      form_data,
      user_email,
      email
    } = req.body;

    let userEmail = user_email || email;
    
    if (!userEmail && form_data && typeof form_data === 'object') {
      const emailFields = [
        'email', 'Email', 'EMAIL',
        'Email Address', 'email address', 'EMAIL ADDRESS',
        'Email ID', 'email id', 'EMAIL ID',
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

    let contactId = null;
    
    try {
      if (userEmail) {
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
          contactId = searchResponse.data.data[0].id;
          console.log('✓ Found existing contact by email:', contactId);
        } else {
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
    }

    let ticketDescription = 'Ticket opened from Discord';
    
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

    const ticketResponse = await axios.post(
      'https://api.intercom.io/tickets',
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
    console.log('Ticket ID:', ticketResponse.data.id);

    const responsePayload = {
      intercom_ticket_id: String(ticketResponse.data.id),
      ticket: {
        status: 'created_in_intercom'
      },
      message: 'Ticket created successfully in Intercom!'
    };

    console.log('=== SENDING RESPONSE TO TICKETS V2 ===');
    console.log(JSON.stringify(responsePayload, null, 2));
    
    res.status(200).json(responsePayload);

    // Register this ticket channel with Discord bot for two-way sync
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

// Secret validation endpoint
app.post('/validate-secrets', async (req, res) => {
  try {
    const { intercom_token, ticket_type_id } = req.body;

    if (!intercom_token || !ticket_type_id) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Missing required secrets: intercom_token and ticket_type_id' 
      });
    }

    const meResponse = await axios.get('https://api.intercom.io/me', {
      headers: {
        'Authorization': `Bearer ${intercom_token}`,
        'Intercom-Version': '2.14'
      }
    });

    const ticketTypeResponse = await axios.get(
      `https://api.intercom.io/ticket_types/${ticket_type_id}`,
      {
        headers: {
          'Authorization': `Bearer ${intercom_token}`,
          'Intercom-Version': '2.14'
        }
      }
    );

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

// Proxy endpoint to fetch and register ticket (forwards to Discord bot)
app.post('/fetch-and-register-ticket', async (req, res) => {
  try {
    const discordBotUrl = process.env.DISCORD_BOT_URL || 'http://localhost:3001';
    
    console.log('=== Proxying fetch-and-register request to Discord bot ===');
    console.log('Target URL:', `${discordBotUrl}/fetch-and-register-ticket`);
    console.log('Payload:', req.body);
    
    const response = await axios.post(
      `${discordBotUrl}/fetch-and-register-ticket`,
      req.body,
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Successfully registered ticket');
    res.json(response.data);
  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    res.status(error.response?.status || 500).json({ 
      error: error.message,
      details: error.response?.data 
    });
  }
});

// 404 handler - MUST BE LAST
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method,
    available_endpoints: [
      'GET / - Health check',
      'GET /health - Health check',
      'POST /intercom-webhook - Intercom webhook handler',
      'POST /tickets-to-intercom - Create ticket',
      'POST /validate-secrets - Validate credentials',
      'POST /fetch-and-register-ticket - Register existing ticket'
    ]
  });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Middleware server running on port ${PORT}`);
  console.log(`📡 Using Intercom API version 2.14`);
  console.log(`✅ Ready to receive tickets from Discord Tickets v2`);
  console.log(`🎯 Webhook endpoint: POST /intercom-webhook`);
  console.log(`🔄 Two-way sync enabled`);
  console.log(`🔗 Proxy endpoint: POST /fetch-and-register-ticket`);
});
