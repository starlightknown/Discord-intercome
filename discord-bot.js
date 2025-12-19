const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Store ticket channel mappings (in production, use a database)
// Format: { discord_channel_id: { intercom_ticket_id, intercom_contact_id, user_id } }
const ticketChannels = new Map();

client.once('ready', () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
});

// Listen to messages in ticket channels (Discord → Intercom)
client.on('messageCreate', async (message) => {
  try {
    // Ignore bot messages to prevent loops
    if (message.author.bot) return;

    // Check if this is a ticket channel
    const ticketInfo = ticketChannels.get(message.channel.id);
    
    if (!ticketInfo) {
      // Not a tracked ticket channel
      return;
    }

    console.log('=== Message in Ticket Channel ===');
    console.log('Channel ID:', message.channel.id);
    console.log('Author:', message.author.tag);
    console.log('Message:', message.content);
    console.log('Intercom Ticket ID:', ticketInfo.intercom_ticket_id);

    const intercomToken = process.env.INTERCOM_TOKEN;
    
    if (!intercomToken) {
      console.error('❌ No Intercom token configured');
      return;
    }

    // Step 1: Get the ticket to find its conversation_id
    const ticketResponse = await axios.get(
      `https://api.intercom.io/tickets/${ticketInfo.intercom_ticket_id}`,
      {
        headers: {
          'Authorization': `Bearer ${intercomToken}`,
          'Intercom-Version': '2.14'
        }
      }
    );

    const conversationId = ticketResponse.data.conversation_id;
    
    if (!conversationId) {
      console.error('❌ No conversation_id found for ticket');
      await message.react('❌').catch(() => {});
      return;
    }

    console.log('✓ Conversation ID:', conversationId);

    // Step 2: Reply to the conversation
    await axios.post(
      `https://api.intercom.io/conversations/${conversationId}/reply`,
      {
        message_type: 'comment',
        type: 'user',
        body: message.content,
        user: {
          id: ticketInfo.intercom_contact_id
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

    console.log('✅ Message forwarded to Intercom');
    await message.react('✅');

  } catch (error) {
    console.error('❌ Error forwarding to Intercom:', error.response?.data || error.message);
    await message.react('❌').catch(() => {});
  }
});

// Endpoint to send message from Intercom to Discord
app.post('/send-to-discord', async (req, res) => {
  try {
    const { channel_id, message, author_name } = req.body;

    console.log('=== Sending to Discord ===');
    console.log('Channel ID:', channel_id);
    console.log('Author:', author_name);
    console.log('Message:', message);

    const channel = await client.channels.fetch(channel_id);
    
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Send message to Discord
    await channel.send({
      content: `**${author_name} (Intercom):**\n${message}`
    });
    
    console.log('✅ Message sent to Discord');
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error sending to Discord:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to register a ticket channel for monitoring
app.post('/register-ticket', async (req, res) => {
  try {
    const { 
      discord_channel_id, 
      intercom_ticket_id, 
      intercom_contact_id,
      user_id 
    } = req.body;

    console.log('=== Registering Ticket Channel ===');
    console.log('Discord Channel:', discord_channel_id);
    console.log('Intercom Ticket:', intercom_ticket_id);
    console.log('Intercom Contact:', intercom_contact_id);

    // Store the mapping
    ticketChannels.set(discord_channel_id, {
      intercom_ticket_id,
      intercom_contact_id,
      user_id,
      registered_at: Date.now()
    });

    console.log('✅ Ticket channel registered');
    console.log(`📊 Total tracked channels: ${ticketChannels.size}`);
    
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error registering ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to unregister a ticket channel (when closed)
app.post('/unregister-ticket', async (req, res) => {
  try {
    const { discord_channel_id } = req.body;

    const wasTracked = ticketChannels.has(discord_channel_id);
    ticketChannels.delete(discord_channel_id);
    
    if (wasTracked) {
      console.log('✅ Ticket channel unregistered:', discord_channel_id);
      console.log(`📊 Total tracked channels: ${ticketChannels.size}`);
    }
    
    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error unregistering ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    bot_ready: client.isReady(),
    tracked_channels: ticketChannels.size,
    bot_user: client.user?.tag || 'Not logged in'
  });
});

// Get all tracked channels (for debugging)
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

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🤖 Discord bot API running on port ${PORT}`);
  console.log(`📡 Monitoring ${ticketChannels.size} ticket channels`);
  console.log(`🔄 Two-way sync enabled`);
});
