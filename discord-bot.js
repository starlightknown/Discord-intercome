const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const express = require('express');
const axios = require('axios');
const FeedbackHandler = require('./feedback-handler');
const { initializeFeedback: initFeedbackFromAPI } = require('./api');

const app = express();
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ]
});

let feedbackHandler = null;
const ticketChannels = new Map();

client.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  initFeedbackFromAPI(client);
});

function setFeedbackHandler(handler) {
  feedbackHandler = handler;
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const ticketInfo = ticketChannels.get(message.channel.id);
    
    if (!ticketInfo) {
      return;
    }

    const intercomToken = process.env.INTERCOM_TOKEN;
    
    if (!intercomToken) {
      console.error('❌ No Intercom token configured');
      return;
    }

    if (!ticketInfo.intercom_contact_id) {
      await message.reply('⚠️ Unable to send message - contact information missing.');
      return;
    }

    let messageBody = message.content.trim();
    
    const attachmentUrls = [];
    if (message.attachments.size > 0) {
      message.attachments.forEach(attachment => {
        attachmentUrls.push(attachment.url);
      });
      
      if (!messageBody) {
        messageBody = '[Image/File attachment]';
      }
    }

    if (!messageBody && attachmentUrls.length === 0) {
      return;
    }

    const replyPayload = {
      message_type: 'comment',
      type: 'user',
      body: messageBody,
      intercom_user_id: ticketInfo.intercom_contact_id
    };

    if (attachmentUrls.length > 0) {
      replyPayload.attachment_urls = attachmentUrls;
    }

    await axios.post(
      `https://api.intercom.io/tickets/${ticketInfo.intercom_ticket_id}/reply`,
      replyPayload,
      {
        headers: {
          'Authorization': `Bearer ${intercomToken}`,
          'Content-Type': 'application/json',
          'Intercom-Version': '2.14'
        }
      }
    );

    await message.react('✅');

  } catch (error) {
    console.error('❌ Error forwarding to Intercom:', error.message);
    await message.react('❌').catch(() => {});
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;

    if (!feedbackHandler) return;

    const modChannelId = process.env.MOD_CHANNEL_ID;
    if (reaction.message.channel.id === modChannelId) {
      await feedbackHandler.handleModApproval(reaction, user);
    }

  } catch (error) {
    console.error('❌ Error handling reaction:', error.message);
  }
});

app.post('/send-to-discord', async (req, res) => {
  try {
    const { channel_id, message, author_name } = req.body;

    const channel = await client.channels.fetch(channel_id);
    
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    await channel.send({
      content: `**${author_name} (Intercom):**\n${message}`
    });
    
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error sending to Discord:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/register-ticket', async (req, res) => {
  try {
    const { 
      discord_channel_id, 
      intercom_ticket_id, 
      intercom_contact_id,
      user_id 
    } = req.body;

    ticketChannels.set(discord_channel_id, {
      intercom_ticket_id,
      intercom_contact_id,
      user_id,
      registered_at: Date.now()
    });

    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error registering ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/unregister-ticket', async (req, res) => {
  try {
    const { discord_channel_id } = req.body;

    ticketChannels.delete(discord_channel_id);
    
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error unregistering ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/fetch-and-register-ticket', async (req, res) => {
  try {
    const { ticket_id, discord_channel_id } = req.body;
    const intercomToken = process.env.INTERCOM_TOKEN;

    if (!intercomToken) {
      return res.status(500).json({ error: 'No Intercom token configured' });
    }

    const ticketResponse = await axios.get(
      `https://api.intercom.io/tickets/${ticket_id}`,
      {
        headers: {
          'Authorization': `Bearer ${intercomToken}`,
          'Intercom-Version': '2.14'
        }
      }
    );

    const ticket = ticketResponse.data;

    const contactId = ticket.contacts?.contacts?.[0]?.id;
    
    if (!contactId) {
      return res.status(400).json({ error: 'No contact found in ticket' });
    }

    const description = ticket.ticket_attributes?._default_description_ || '';
    const userIdMatch = description.match(/Discord User ID: (\d+)/);
    const userId = userIdMatch ? userIdMatch[1] : null;

    ticketChannels.set(discord_channel_id, {
      intercom_ticket_id: ticket_id,
      intercom_contact_id: contactId,
      user_id: userId,
      registered_at: Date.now()
    });

    res.json({ 
      success: true,
      ticket_id: ticket_id,
      contact_id: contactId,
      user_id: userId,
      title: ticket.ticket_attributes?._default_title_
    });

  } catch (error) {
    console.error('❌ Error fetching ticket:', error.message);
    res.status(500).json({ 
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    bot_ready: client.isReady(),
    tracked_channels: ticketChannels.size,
    bot_user: client.user?.tag || 'Not logged in',
    feedback_enabled: feedbackHandler !== null
  });
});

app.get('/tracked-channels', (req, res) => {
  const channels = Array.from(ticketChannels.entries()).map(([channelId, info]) => ({
    discord_channel_id: channelId,
    intercom_ticket_id: info.intercom_ticket_id,
    intercom_contact_id: info.intercom_contact_id,
    user_id: info.user_id,
    registered_at: new Date(info.registered_at).toISOString()
  }));
  
  res.json({ 
    total: channels.length,
    channels 
  });
});

app.post('/update-dashboard', async (req, res) => {
  try {
    const { channel_id } = req.body;

    if (!feedbackHandler) {
      return res.status(503).json({ error: 'Feedback system not initialized' });
    }

    await feedbackHandler.updatePublicDashboard(channel_id);
    res.json({ success: true });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🤖 Discord bot API running on port ${PORT}`);
  console.log(`🔄 Two-way sync enabled`);
});

module.exports = { client, feedbackHandler };
