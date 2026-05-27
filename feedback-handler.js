const axios = require('axios');
const { FeedbackManager, DuplicateDetector } = require('./feedback');

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
        ...intercomDupes.map((m) => ({ feedback: m, similarity: m.similarity })),
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
        console.warn('⚠️  Mod channel not found');
        return;
      }

      let similarText = '';
      if (similarFeedback && similarFeedback.length > 0) {
        similarText = '\n\n**Similar Feedback Found:**\n';
        similarFeedback.slice(0, 3).forEach((m) => {
          const similarity =
            m.similarity instanceof Object
              ? (m.similarity * 100).toFixed(0)
              : Math.round(m.similarity * 100);
          similarText += `• ${similarity}% match: "${m.feedback?.['Feedback Text'] || m.text}"\n`;
        });
      }

      const embed = {
        color: 0x3498db,
        title: '📥 New Feedback Pending Review',
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

      console.log('✅ Notified mods of pending feedback');
    } catch (error) {
      console.error(
        '❌ Error notifying mods:',
        error.message
      );
    }
  }

  async handleModApproval(reaction, user) {
    try {
      if (user.bot) return;

      const message = reaction.message;
      const embed = message.embeds[0];

      if (!embed || !embed.title.includes('Pending Review')) {
        return;
      }

      const feedbackId = embed.fields?.find((f) => f.name === 'Feedback ID')
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

      await this.feedbackManager.updateFeedbackStatus(feedbackId, newStatus);

      const feedback = await this.feedbackManager.getFeedbackById(feedbackId);

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

      console.log(`✅ Feedback ${feedbackId} marked as ${newStatus}`);
    } catch (error) {
      console.error('❌ Error handling mod approval:', error.message);
    }
  }

  async postToSlack(feedback) {
    try {
      const slackWebhook = process.env.SLACK_WEBHOOK_URL;
      const slackChannel = process.env.SLACK_CHANNEL;

      if (!slackWebhook || !slackChannel) {
        console.warn('⚠️  Slack webhook or channel not configured');
        return;
      }

      const message = {
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
                value: feedback.Email,
                short: true,
              },
              {
                title: 'Requests',
                value:
                  feedback['Duplicate Count'] || '1',
                short: true,
              },
              {
                title: 'Discord User',
                value: feedback['Discord User'],
                short: true,
              },
              {
                title: 'Feedback ID',
                value: feedback.ID,
                short: true,
              },
            ],
            ts: Math.floor(new Date().getTime() / 1000),
          },
        ],
      };

      await axios.post(slackWebhook, message);
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
