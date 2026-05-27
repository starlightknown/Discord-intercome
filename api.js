const express = require('express');
const axios = require('axios');
const FeedbackHandler = require('./feedback-handler');
const app = express();

app.use(express.json());

let feedbackHandler = null;

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

app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'Intercom Tickets Middleware + Feedback System',
    version: '2.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    api_version: '2.14',
    feedback_enabled: feedbackHandler !== null
  });
});

app.post('/intercom-webhook', async (req, res) => {
  try {
    console.log('=== WEBHOOK RECEIVED ===');
    console.log('Topic:', req.body.topic);
    
    res.status(200).json({ received: true });

    const { topic, data } = req.body;

    if (!topic || topic === 'ping') {
      console.log('✓ Webhook test received');
      return;
    }

    if (topic !== 'ticket.admin.replied' && topic !== 'conversation.admin.replied') {
      console.log('Ignoring topic:', topic);
      return;
    }

    console.log('Processing admin reply...');

    const ticket = data?.item?.ticket || data?.item?.conversation;
    const ticketPart = data?.item?.ticket_part || data?.item?.conversation_part;

    if (!ticket || !ticketPart) {
      console.log('No ticket/conversation or part found');
      return;
    }

    if (ticketPart.author?.type !== 'admin' && ticketPart.author?.type !== 'bot') {
      console.log('Ignoring non-admin message');
      return;
    }

    const adminName = ticketPart.author?.name || 'Support Agent';
    const message = stripHtml(ticketPart.body);

    console.log('Admin:', adminName);
    console.log('Message:', message);

    const description = ticket.ticket_attributes?._default_description_ || '';
    const channelMatch = description.match(/Channel ID: (\d+)/);
    
    if (!channelMatch) {
      console.error('❌ No Discord channel ID found in ticket description');
      return;
    }

    const discordChannelId = channelMatch[1];
    console.log('Discord Channel ID:', discordChannelId);

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

app.post('/feedback-submission', async (req, res) => {
  if (!feedbackHandler) {
    return res.status(503).json({ 
      success: false, 
      error: 'Feedback system not initialized' 
    });
  }

  await feedbackHandler.handleTicketsWebhook(req, res);
});

app.post('/tickets-to-intercom', async (req, res) => {
  try {
    const intercomToken = req.headers['authorization']?.replace('Bearer ', '');
    const ticketTypeId = req.headers['x-ticket-type-id'];
    const isFeedback = req.headers['x-ticket-type'] === 'feedback';

    if (!intercomToken || !ticketTypeId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required headers: Authorization and X-Ticket-Type-Id'
      });
    }

    console.log('=== Received Ticket ===');
    console.log('Is Feedback:', isFeedback);
    console.log('Ticket Type ID:', ticketTypeId);

    if (isFeedback && feedbackHandler) {
      return await feedbackHandler.handleTicketsWebhook(req, res);
    }

    const {
      guild_id,
      user_id,
      ticket_id,
      ticket_channel_id,
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
          break;
        }
      }
    }

    console.log('User email:', userEmail || 'Not provided');

    let contactId = null;
    
    try {
      if (userEmail) {
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
        } else {
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
        }
      } else {
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
        } else {
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

    const responsePayload = {
      intercom_ticket_id: String(ticketResponse.data.id),
      ticket: {
        status: 'created_in_intercom'
      },
      message: 'Ticket created successfully in Intercom!'
    };
    
    res.status(200).json(responsePayload);

    const discordBotUrl = process.env.DISCORD_BOT_URL || 'http://localhost:3001';
    
    try {
      await axios.post(`${discordBotUrl}/register-ticket`, {
        discord_channel_id: ticket_channel_id,
        intercom_ticket_id: ticketResponse.data.id,
        intercom_contact_id: contactId,
        user_id: user_id
      });
    } catch (error) {
      console.error('⚠️  Failed to register with Discord bot:', error.message);
    }

  } catch (error) {
    console.error('=== ERROR ===');
    console.error('Message:', error.message);

    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
      ticket: {
        status: 'failed'
      }
    });
  }
});

app.post('/validate-secrets', async (req, res) => {
  try {
    const { intercom_token, ticket_type_id } = req.body;

    if (!intercom_token || !ticket_type_id) {
      return res.status(400).json({ 
        valid: false, 
        error: 'Missing required secrets' 
      });
    }

    await axios.get('https://api.intercom.io/me', {
      headers: {
        'Authorization': `Bearer ${intercom_token}`,
        'Intercom-Version': '2.14'
      }
    });

    res.status(200).json({ 
      valid: true
    });

  } catch (error) {
    res.status(400).json({ 
      valid: false, 
      error: error.message
    });
  }
});

app.post('/init-feedback', async (req, res) => {
  try {
    if (feedbackHandler) {
      return res.json({ status: 'already_initialized' });
    }

    const { client } = req.body;
    if (!client) {
      return res.status(400).json({ error: 'Discord client required' });
    }

    console.log('Initializing feedback handler...');
    res.json({ status: 'feedback_initialized' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    method: req.method
  });
});

const PORT = process.env.PORT || 10000;

function initialize(discordClient) {
  feedbackHandler = new FeedbackHandler(discordClient);
  feedbackHandler.initialize().catch(error => {
    console.error('❌ Failed to initialize feedback:', error);
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Middleware server running on port ${PORT}`);
  console.log(`📡 Using Intercom API version 2.14`);
  console.log(`✅ Ready to receive tickets from Discord Tickets v2`);
});

module.exports = { app, initialize };
