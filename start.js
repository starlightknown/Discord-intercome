require('dotenv').config();

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const axios = require('axios');
const FeedbackHandler = require('./feedback-handler');
const { app, initializeFeedback } = require('./api');

console.log('🚀 Starting Intercom + Feedback Bot System...\n');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions,
  ]
});

const ticketChannels = new Map();

client.once('ready', async () => {
  console.log(`✅ Discord bot logged in as ${client.user.tag}`);
  initializeFeedback(client);
  
  try {
    const feedbackChannelId = process.env.FEEDBACK_CHANNEL_ID || '1509139144042090626';
    const feedbackChannel = await client.channels.fetch(feedbackChannelId);
    
    if (feedbackChannel && feedbackChannel.isTextBased()) {
      const button = new ButtonBuilder()
        .setCustomId('feedback_button')
        .setLabel('📝 Submit Feedback')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      await feedbackChannel.send({
        content: '**📝 Have feedback or a feature request?**\nClick the button below to submit!',
        components: [row]
      });
      console.log('✅ Feedback button posted to channel');
    }
  } catch (error) {
    console.warn('⚠️ Could not post feedback button:', error.message);
  }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    const ticketInfo = ticketChannels.get(message.channel.id);
    if (!ticketInfo) return;

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

    if (!messageBody && attachmentUrls.length === 0) return;

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

    const modChannelId = process.env.MOD_CHANNEL_ID;
    console.log(`🔔 Reaction added by ${user.username} in channel ${reaction.message.channel.id}, emoji: ${reaction.emoji.name}`);
    
    if (reaction.message.channel.id === modChannelId) {
      console.log('✅ Reaction in mod channel, processing...');
      const feedbackHandler = global.feedbackHandler;
      if (feedbackHandler) {
        await feedbackHandler.handleModApproval(reaction, user);
      } else {
        console.warn('⚠️  Feedback handler not initialized');
      }
    }
  } catch (error) {
    console.error('❌ Error handling reaction:', error.message, error.stack);
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'feedback_button') {
        const modal = new ModalBuilder()
          .setCustomId('feedback_modal')
          .setTitle('📝 Submit Feedback');

        const feedbackInput = new TextInputBuilder()
          .setCustomId('feedback_text')
          .setLabel('Your Feedback')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Describe your feedback or feature request...')
          .setRequired(true)
          .setMaxLength(500);

        const emailInput = new TextInputBuilder()
          .setCustomId('feedback_email')
          .setLabel('Your Email')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('your@email.com')
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(feedbackInput),
          new ActionRowBuilder().addComponents(emailInput)
        );

        await interaction.showModal(modal);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'feedback_modal') {
        const feedbackText = interaction.fields.getTextInputValue('feedback_text');
        const email = interaction.fields.getTextInputValue('feedback_email');
        const userId = interaction.user.id;
        const username = interaction.user.username;

        await interaction.deferReply({ ephemeral: true });

        try {
          const response = await axios.post('http://localhost:3001/feedback-submission', {
            user_id: userId,
            user_email: email,
            ticket_id: `discord_${userId}_${Date.now()}`,
            form_data: {
              feedback: feedbackText,
              email: email,
              username: username
            }
          });

          await interaction.editReply({
            content: `✅ **Feedback submitted!**\nID: ${response.data.feedback_id}\n\nThank you for your input!`,
            ephemeral: true
          });

          await updateDashboard();
        } catch (error) {
          console.error('Error submitting feedback:', error.message);
          await interaction.editReply({
            content: '❌ Failed to submit feedback. Please try again.',
            ephemeral: true
          });
        }
      }
    }
  } catch (error) {
    console.error('❌ Error handling interaction:', error.message);
  }
});

async function updateDashboard() {
  try {
    const dashboardChannelId = process.env.PUBLIC_DASHBOARD_CHANNEL_ID || '1509139144042090626';
    const feedbackChannel = await client.channels.fetch(dashboardChannelId);
    
    if (!feedbackChannel || !feedbackChannel.isTextBased()) return;

    const fs = require('fs');
    const feedbackPath = './feedback-data.json';
    
    let feedbackData = [];
    if (fs.existsSync(feedbackPath)) {
      feedbackData = JSON.parse(fs.readFileSync(feedbackPath, 'utf-8'));
    }

    const approved = feedbackData.filter(f => f.Status === 'approved');
    const working = feedbackData.filter(f => f.Status === 'working');
    const rejected = feedbackData.filter(f => f.Status === 'rejected');
    const pending = feedbackData.filter(f => f.Status === 'pending');

    const embed = {
      color: 0x9b59b6,
      title: '📊 Feedback Dashboard',
      fields: [
        {
          name: '✅ Forwarded to Team',
          value: approved.length > 0
            ? approved.map(f => `• ${f['Feedback Text'].substring(0, 40)}... (${f['Duplicate Count']} requests)`).join('\n')
            : 'No approved feedback yet',
          inline: false,
        },
        {
          name: '🏗️ Working On It',
          value: working.length > 0
            ? working.map(f => `• ${f['Feedback Text'].substring(0, 40)}...`).join('\n')
            : 'No in-progress items',
          inline: false,
        },
        {
          name: '❌ Not Planned',
          value: rejected.length > 0
            ? rejected.map(f => `• ${f['Feedback Text'].substring(0, 40)}...`).join('\n')
            : 'No rejected items',
          inline: false,
        },
        {
          name: '📈 Stats',
          value: `Total: ${feedbackData.length} | Pending: ${pending.length} | Approved: ${approved.length}`,
          inline: false,
        },
      ],
      timestamp: new Date(),
    };

    const messages = await feedbackChannel.messages.fetch({ limit: 10 });
    const dashboardMsg = messages.find(m => m.embeds[0]?.title === '📊 Feedback Dashboard');

    if (dashboardMsg) {
      await dashboardMsg.edit({ embeds: [embed] });
    } else {
      await feedbackChannel.send({ embeds: [embed] });
    }

    console.log('✅ Dashboard updated');
  } catch (error) {
    console.error('⚠️ Failed to update dashboard:', error.message);
  }
}

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`🤖 Discord bot API running on port ${PORT}`);
  console.log(`🔄 Two-way sync enabled`);
});

app.post('/register-ticket', async (req, res) => {
  try {
    const { discord_channel_id, intercom_ticket_id, intercom_contact_id, user_id } = req.body;
    ticketChannels.set(discord_channel_id, {
      intercom_ticket_id,
      intercom_contact_id,
      user_id,
      registered_at: Date.now()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/unregister-ticket', async (req, res) => {
  try {
    const { discord_channel_id } = req.body;
    ticketChannels.delete(discord_channel_id);
    res.json({ success: true });
  } catch (error) {
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
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    bot_ready: client.isReady(),
    tracked_channels: ticketChannels.size,
    bot_user: client.user?.tag || 'Not logged in'
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
  
  res.json({ total: channels.length, channels });
});

app.post('/update-dashboard', async (req, res) => {
  try {
    const { channel_id } = req.body;
    const feedbackHandler = global.feedbackHandler;

    if (!feedbackHandler) {
      return res.status(503).json({ error: 'Feedback system not initialized' });
    }

    await feedbackHandler.updatePublicDashboard(channel_id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

global.updateDashboardFunc = updateDashboard;

client.login(process.env.DISCORD_BOT_TOKEN);
