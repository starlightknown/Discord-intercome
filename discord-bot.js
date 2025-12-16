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
// Format: { discord_channel_id: { intercom_ticket_id, user_id } }
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

    // Forward message to Intercom as ticket reply
    const intercomToken = process.env.INTERCOM_TOKEN;
    
    if (!intercomToken) {
      console.error('No Intercom token configured');
      return;
    }

    // Send reply to Intercom ticket
    await axios.post(
      `https://api.intercom.io/tickets/${ticketInfo.intercom_ticket_id}/reply`,
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

    console.log('✓ Message forwarded to Intercom');

    // React to message to show it was sent
    await message.react('✅');

  } catch (error) {
    console.error('Error forwarding to Intercom:', error.response?.data || error.message);
    // React with error emoji
    await message.react('❌').catch(() => {});
  }
});

// Endpoint to send message from Intercom to Discord
app.post('/send-to-discord', async (req, res) => {
  try {
    const { channel_id, message, author_name } = req.body;

    console.log('=== Sending to Discord ===');
    console.log('Channel ID:', channel_id);
    console.log('Message:', message);

    const channel = await client.channels.fetch(channel_id);
    
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ error: 'Channel not found' });
    }

    // Send message to Discord
    await channel.send({
      content: `**${author_name} (Intercom):**\n${message}`
    });
    
    console.log('✓ Message sent to Discord');
    res.json({ success: true });

  } catch (error) {
    console.error('Error sending to Discord:', error);
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

    // Store the mapping
    ticketChannels.set(discord_channel_id, {
      intercom_ticket_id,
      intercom_contact_id,
      user_id,
      registered_at: Date.now()
    });

    console.log('✓ Ticket channel registered');
    res.json({ success: true });

  } catch (error) {
    console.error('Error registering ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to unregister a ticket channel (when closed)
app.post('/unregister-ticket', async (req, res) => {
  try {
    const { discord_channel_id } = req.body;

    ticketChannels.delete(discord_channel_id);
    console.log('✓ Ticket channel unregistered:', discord_channel_id);
    
    res.json({ success: true });

  } catch (error) {
    console.error('Error unregistering ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    bot_ready: client.isReady(),
    tracked_channels: ticketChannels.size
  });
});

// Login to Discord
client.login(process.env.DISCORD_BOT_TOKEN);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🤖 Discord bot API running on port ${PORT}`);
  console.log(`📡 Monitoring ${ticketChannels.size} ticket channels`);
});
