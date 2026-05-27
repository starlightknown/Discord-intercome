const axios = require('axios');
const { FeedbackManager, DuplicateDetector } = require('./feedback');
const { WebClient } = require('@slack/web-api');

class FeedbackHandler {
  constructor(discordClient) {
    this.client = discordClient;
    this.feedbackManager = new FeedbackManager();
    this.duplicateDetector = new DuplicateDetector();
    this.duplicateDetector.setFeedbackManager(this.feedbackManager);
    this.feedbackMessages = new Map();
  }

  async initialize() {
    await this.feedbackManager.initialize();
    console.log('✅ Feedback handler initialized');
  }

  async handleTicketsWebhook(req, res) {
    try {
      const { user_id, user_email, ticket_id, ticket_channel_id, form_data } =
        req.body;

      let feedbackText = '';
      let email = user_email;

      if (form_data && typeof form_data === 'object') {
        const textFields = ['feedback', 'message', 'description', 'text'];
        const emailFields = [
          'email',
          'Email',
          'user_email',
          'contact_email',
          'Email Address',
        ];

        for (const field of textFields) {
          if (form_data[field]) {
            feedbackText = form_data[field];
            break;
          }
        }

        for (const field of emailFields) {
          if (form_data[field]) {
            email = form_data[field];
            break;
          }
        }
      }

      if (!feedbackText) {
        return res.status(400).json({
          success: false,
          error: 'No feedback text found in form data',
        });
      }

      console.log('=== Feedback Submission ===');
      console.log('User:', user_id);
      console.log('Email:', email);
      console.log('Feedback:', feedbackText.substring(0, 100));

      const duplicationResult = await this.duplicateDetector.detectDuplicates(
        feedbackText
      );

      const intercomDupes = await this.duplicateDetector.checkIntercomDuplicates(
        feedbackText,
        process.env.INTERCOM_TOKEN
      );

      const allMatches = [
        ...duplicationResult.matches,
        ...intercomDupes,
      ];

      let dbFeedback = null;

      if (duplicationResult.isDuplicate && duplicationResult.matches.length > 0) {
        const originalFeedback =
          duplicationResult.matches[0].feedback ||
          duplicationResult.matches[0];
        const originalId = originalFeedback.ID || originalFeedback.id;

        await this.feedbackManager.updateDuplicateCount(
          originalId,
          parseInt(originalFeedback['Duplicate Count'] || 1) + 1
        );

        console.log(
          `⚠️  Duplicate detected for ${originalId}, incrementing count`
        );

        dbFeedback = {
          id: `DUP-${Date.now()}`,
          originalId,
          isDuplicate: true,
          discordUser: user_id,
          email,
          feedbackText,
        };

        res.status(200).json({
          success: true,
          message: 'Feedback received (marked as duplicate)',
          duplicate_of: originalId,
          similar_feedback: duplicationResult.matches.map((m) => ({
            id: m.feedback?.ID,
            text: m.feedback?.['Feedback Text'],
            similarity: m.similarity || 'exact',
          })),
        });

        await this.notifyModsOfPendingFeedback(dbFeedback, duplicationResult.matches);
      } else {
        dbFeedback = await this.feedbackManager.addFeedback({
          discordUser: user_id,
          email,
          feedbackText,
          duplicateCount: 1,
        });

        console.log(`✅ New feedback added: ${dbFeedback.id}`);

        res.status(200).json({
          success: true,
          message: 'Feedback submitted for review',
          feedback_id: dbFeedback.id,
          similar_feedback:
            allMatches.length > 0
              ? allMatches.map((m) => ({
                  text: m.feedback?.['Feedback Text'] || m.title,
                  similarity: (m.similarity * 100).toFixed(0) + '%',
                }))
              : [],
        });

        await this.notifyModsOfPendingFeedback(dbFeedback, allMatches);
      }
    } catch (error) {
      console.error('❌ Error handling feedback webhook:', error.message);
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }

  async notifyModsOfPendingFeedback(feedback, similarFeedback) {
    try {
      const modChannelId = process.env.MOD_CHANNEL_ID;
      if (!modChannelId) {
        console.warn('⚠️  MOD_CHANNEL_ID not set');
        return;
      }

      const channel = await this.client.channels.fetch(modChannelId);
      if (!channel || !channel.isTextBased()) {
        console.warn('⚠️  Mod channel not found or not text-based');
        return;
      }

      let similarText = '';
      if (similarFeedback && similarFeedback.length > 0) {
        similarText = '\n\n**Similar Feedback Found:**\n';
        similarFeedback.slice(0, 3).forEach((m) => {
          const similarity = Math.round((m.similarity || 0) * 100);
          const feedbackText = m.feedback?.['Feedback Text'] || m['Feedback Text'] || 'Unknown';
          const source = m.feedback?.source === 'intercom' || m.source === 'intercom' ? ' (Intercom)' : '';
          similarText += `• ${similarity}% match: "${feedbackText}"${source}\n`;
        });
      }

      const title = feedback.isDuplicate ? '🔄 Duplicate Feedback Submitted' : '📥 New Feedback Pending Review';
      const color = feedback.isDuplicate ? 0xf39c12 : 0x3498db;

      const embed = {
        color,
        title,
        fields: [
          {
            name: 'Feedback ID',
            value: feedback.id,
            inline: true,
          },
          {
            name: 'Email',
            value: feedback.email || 'Not provided',
            inline: true,
          },
          {
            name: 'Discord User',
            value: feedback.discordUser || 'Unknown',
            inline: true,
          },
          {
            name: 'Feedback',
            value: feedback.feedbackText.substring(0, 500),
            inline: false,
          },
        ],
        timestamp: new Date(),
      };

      if (feedback.isDuplicate && feedback.originalId) {
        embed.fields.push({
          name: 'Duplicate Of',
          value: feedback.originalId,
          inline: true,
        });
      }

      if (similarText) {
        embed.fields.push({
          name: 'Similar Feedback',
          value: similarText,
          inline: false,
        });
      }

      const message = await channel.send({ embeds: [embed] });

      this.feedbackMessages.set(feedback.id, {
        messageId: message.id,
        channelId: modChannelId,
      });

      await message.react('✅');
      await message.react('❌');
      await message.react('🏗️');

      console.log(`✅ Notified mods of ${feedback.isDuplicate ? 'duplicate' : 'new'} feedback: ${feedback.id}`);
    } catch (error) {
      console.error(
        '❌ Error notifying mods:',
        error.message,
        error.stack
      );
    }
  }

  async handleModApproval(reaction, user) {
    try {
      if (user.bot) return;

      console.log(`📋 Processing reaction: ${reaction.emoji.name} from ${user.username}`);

      const message = reaction.message;
      const embed = message.embeds[0];

      if (!embed) {
        console.log('⚠️  No embed found in message');
        return;
      }

      console.log(`📌 Embed title: ${embed.title}`);

      if (!embed.title.includes('Pending Review') && !embed.title.includes('Duplicate')) {
        console.log('⚠️  Not a feedback embed, ignoring');
        return;
      }

      const feedbackId = embed.fields?.find((f) => f.name === 'Feedback ID')
        ?.value;
      const duplicateOf = embed.fields?.find((f) => f.name === 'Duplicate Of')
        ?.value;

      if (!feedbackId) {
        return;
      }

      let newStatus = '';

      switch (reaction.emoji.name) {
        case '✅':
          newStatus = 'approved';
          break;
        case '❌':
          newStatus = 'rejected';
          break;
        case '🏗️':
          newStatus = 'working';
          break;
        default:
          return;
      }

      const targetId = duplicateOf || feedbackId;
      
      await this.feedbackManager.updateFeedbackStatus(targetId, newStatus);

      const feedback = await this.feedbackManager.getFeedbackById(targetId);

      const statusEmojis = {
        approved: '✅',
        rejected: '❌',
        working: '🏗️',
      };

      const updatedEmbed = {
        ...embed,
        color: newStatus === 'approved' ? 0x2ecc71 : 0xe74c3c,
        title: `${statusEmojis[newStatus]} Feedback - ${newStatus.toUpperCase()}`,
        footer: {
          text: `Reviewed by ${user.username}`,
          icon_url: user.displayAvatarURL(),
        },
      };

      await message.edit({ embeds: [updatedEmbed] });

      if (newStatus === 'approved') {
        await this.postToSlack(feedback);
      }

      global.updateDashboardFunc && await global.updateDashboardFunc();

      console.log(`✅ Feedback ${targetId} marked as ${newStatus}`);
    } catch (error) {
      console.error('❌ Error handling mod approval:', error.message);
    }
  }

  async postToSlack(feedback) {
    try {
      const slackBotToken = process.env.SLACK_BOT_TOKEN;
      const slackChannel = process.env.SLACK_CHANNEL;

      if (!slackBotToken || !slackChannel) {
        console.warn('⚠️  Slack bot token or channel not configured');
        return;
      }

      const slack = new WebClient(slackBotToken);

      const duplicateCount = feedback['Duplicate Count'] || feedback.duplicateCount || '1';

      await slack.chat.postMessage({
        channel: slackChannel,
        attachments: [
          {
            color: '2ecc71',
            title: '✅ New Feedback Forwarded',
            fields: [
              {
                title: 'Feedback',
                value: feedback['Feedback Text'],
                short: false,
              },
              {
                title: 'From',
                value: feedback.Email || feedback.email || 'Unknown',
                short: true,
              },
              {
                title: 'Requests',
                value: String(duplicateCount),
                short: true,
              },
              {
                title: 'Discord User',
                value: feedback['Discord User'] || feedback.discordUser || 'Unknown',
                short: true,
              },
              {
                title: 'Feedback ID',
                value: feedback.ID || feedback.id,
                short: true,
              },
            ],
            ts: Math.floor(new Date().getTime() / 1000),
          },
        ],
      });

      console.log('✅ Posted to Slack');
    } catch (error) {
      console.error('❌ Error posting to Slack:', error.message);
    }
  }

  async updatePublicDashboard(channelId) {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        console.warn('⚠️  Dashboard channel not found');
        return;
      }

      const allFeedback = await this.feedbackManager.getAllFeedback();

      const forwarded = allFeedback.filter((f) => f.Status === 'approved');
      const working = allFeedback.filter((f) => f.Status === 'working');
      const notPlanned = allFeedback.filter((f) => f.Status === 'rejected');

      const embed = {
        color: 0x9b59b6,
        title: '📊 Feedback Status Dashboard',
        fields: [
          {
            name: '✅ Forwarded to Team',
            value:
              forwarded.length > 0
                ? forwarded
                    .map(
                      (f) =>
                        `• ${f['Feedback Text'].substring(0, 50)}... (${f['Duplicate Count']} requests)`
                    )
                    .join('\n')
                : 'No approved feedback yet',
            inline: false,
          },
          {
            name: '🏗️ Working On It',
            value:
              working.length > 0
                ? working
                    .map((f) => `• ${f['Feedback Text'].substring(0, 50)}...`)
                    .join('\n')
                : 'No in-progress items',
            inline: false,
          },
          {
            name: '❌ Not Planned',
            value:
              notPlanned.length > 0
                ? notPlanned
                    .map((f) => `• ${f['Feedback Text'].substring(0, 50)}...`)
                    .join('\n')
                : 'No rejected items',
            inline: false,
          },
          {
            name: '📈 Total Feedback',
            value: allFeedback.length.toString(),
            inline: true,
          },
          {
            name: 'Pending Review',
            value: allFeedback.filter((f) => f.Status === 'pending').length.toString(),
            inline: true,
          },
        ],
        timestamp: new Date(),
      };

      const messages = await channel.messages.fetch({ limit: 10 });
      const dashboardMsg = messages.find(
        (m) => m.embeds[0]?.title === '📊 Feedback Status Dashboard'
      );

      if (dashboardMsg) {
        await dashboardMsg.edit({ embeds: [embed] });
      } else {
        await channel.send({ embeds: [embed] });
      }

      console.log('✅ Updated public dashboard');
    } catch (error) {
      console.error('❌ Error updating dashboard:', error.message);
    }
  }
}

module.exports = FeedbackHandler;
