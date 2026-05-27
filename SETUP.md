# Feedback Bot Setup Guide

Complete end-to-end setup for Discord Feedback System with Deduplication & Slack Integration.

## Prerequisites

- **Discord Bot** (already set up with Tickets v2)
- **Intercom Account** with API token
- **Google Sheets** (new empty sheet for feedback)
- **Slack Workspace** with webhook access
- **Node.js 18+**

---

## 1. Google Sheets Setup

### Create Spreadsheet
1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new blank spreadsheet
3. Name it "Feedback"
4. Copy the **Spreadsheet ID** from the URL: `https://docs.google.com/spreadsheets/d/{SPREADSHEET_ID}/edit`

### Get Google Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project
3. Enable **Google Sheets API**
4. Create a **Service Account**:
   - IAM & Admin → Service Accounts → Create Service Account
   - Grant **Editor** role
5. Create JSON key:
   - Click on service account → Keys → Add Key → JSON
   - Download and save as `google-credentials.json` in project root
6. Share your Google Sheet with the service account email (found in JSON file)

---

## 2. Discord Setup

### Create Mod Channel
1. In your Discord server, create a **#feedback-modqueue** channel (mod-only)
2. Get the **Channel ID**:
   - Enable Developer Mode (Discord → User Settings → Advanced → Developer Mode)
   - Right-click channel → Copy Channel ID

### Create Public Dashboard Channel
1. Create a **#feedback-dashboard** channel (public)
2. Get the **Channel ID**

---

## 3. Slack Setup

### Create Slack Webhook
1. Go to your Slack workspace settings → Apps & integrations
2. Create an incoming webhook for **#feedback-river**
3. Copy the webhook URL

---

## 4. Tickets v2 Feedback Form Setup

### Create Feedback Ticket Type
1. In Tickets v2 bot settings, create a new ticket type called **"Feedback"**
2. Configure form fields:
   - **Feedback**: text field (required)
   - **Email**: email field (required)
   - **Any other fields** as needed

### Configure Form to Send to Bot
1. In Tickets v2 webhook settings, add a new endpoint:
   - **URL**: `https://your-bot-domain.com/feedback-submission`
   - **Headers**: 
     ```
     Authorization: Bearer [INTERCOM_TOKEN]
     X-Ticket-Type-Id: [FEEDBACK_TICKET_TYPE_ID]
     X-Ticket-Type: feedback
     ```
   - **Trigger**: On feedback form submission

---

## 5. Environment Variables

Create `.env` file in project root:

```bash
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_BOT_URL=http://localhost:3001
INTERCOM_TOKEN=your_intercom_token_here

GOOGLE_SHEETS_ID=your_sheet_id_here
GOOGLE_CREDENTIALS_PATH=./google-credentials.json

SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
SLACK_CHANNEL=#feedback-river

MOD_CHANNEL_ID=your_mod_channel_id_here
PUBLIC_DASHBOARD_CHANNEL_ID=your_public_dashboard_channel_id_here

PORT=10000
```

---

## 6. Installation & Deployment

### Local Testing
```bash
npm install
npm run dev  # Start API server
node discord-bot.js  # In another terminal
```

### Deploy to Render

1. **Push code to GitHub** (private repo preferred)
2. **Connect Render**:
   - Create new Web Service on Render
   - Connect GitHub repo
   - Build command: `npm install`
   - Start command: `npm start`
   - Add environment variables from `.env`
   - Deploy

3. **Update Bot URLs**:
   - Update `DISCORD_BOT_URL` to your Render URL
   - Update Tickets v2 webhook URL to point to Render

---

## 7. Testing Workflow

### Test End-to-End

1. **Submit feedback** via Tickets v2 form
2. **Check Google Sheets** → New row should appear with "pending" status
3. **Check Discord mod channel** → Embed with feedback details and reactions
4. **Mod approves** → React with ✅
5. **Check Slack** → Message posted to #feedback-river
6. **Check public dashboard** → Feedback appears in "Forwarded to Team" section

### Test Duplicate Detection

1. Submit similar feedback within same conversation
2. Bot should detect and link to original feedback
3. Original feedback's "Duplicate Count" should increase
4. Slack message shows total requests count

---

## 8. Using the Dashboard

### Mod Channel Actions
- **✅ Approve**: Posts to Slack, changes status to "approved"
- **❌ Reject**: Changes status to "rejected"
- **🏗️ Working**: Changes status to "working on it"

### Public Dashboard Shows
- **Forwarded to Team**: Approved feedback (with duplicate count)
- **Working On It**: Items in progress
- **Not Planned**: Rejected items
- **Pending Review**: Count of items awaiting mod decision

### Update Dashboard
Dashboard updates automatically when mods approve/reject. Force update with:
```bash
curl -X POST http://localhost:3001/update-dashboard \
  -H "Content-Type: application/json" \
  -d '{"channel_id": "YOUR_PUBLIC_CHANNEL_ID"}'
```

---

## 9. Troubleshooting

### Feedback Not Appearing in Sheets
- Check Google Sheets API is enabled
- Verify `google-credentials.json` exists and is valid
- Check service account has edit access to sheet
- View API errors: `GOOGLE_DEBUG=1 npm start`

### Duplicates Not Detected
- Semantic similarity requires similarity server (optional)
- Without it, only exact matches are detected
- To enable semantic similarity:
  ```bash
  pip install flask sentence-transformers
  python similarity-server.py  # Run in separate process
  ```

### Slack Messages Not Posting
- Verify webhook URL is correct
- Check channel name matches in `.env`
- Test webhook manually: `curl -X POST [WEBHOOK_URL] -d '{"text":"test"}'`

### Reactions Not Working
- Ensure bot has Message Add Reactions permission
- Check mod channel ID is correct
- Verify bot can access the channel

---

## File Structure

```
.
├── api.js                    # Express API + Tickets v2 handler
├── discord-bot.js            # Discord bot + mod approval logic
├── feedback.js               # Google Sheets + duplicate detection
├── feedback-handler.js       # Feedback workflow orchestration
├── start.js                  # Process manager
├── package.json              # Dependencies
├── .env                      # Environment variables (create yourself)
├── .env.example              # Example configuration
└── google-credentials.json   # Google API creds (create yourself)
```

---

## API Endpoints

### POST `/feedback-submission`
Receive feedback from Tickets v2 form.
```json
{
  "user_id": "discord_user_id",
  "user_email": "user@example.com",
  "ticket_id": "ticket_123",
  "form_data": {
    "feedback": "Feature request text",
    "email": "user@example.com"
  }
}
```

### POST `/update-dashboard`
Update public dashboard embed.
```json
{
  "channel_id": "public_channel_id"
}
```

### GET `/health`
Check system health.

---

## Monitoring

Logs are output to the console. For production, it's recommended to:
- Redirect stdout/stderr to file
- Use log aggregation service (Render, Datadog, etc.)
- Set up Discord bot status alerts

---

## Support

For issues or questions, check:
1. Console logs for errors
2. Google Sheets API quota
3. Discord bot permissions
4. Slack webhook validity
5. Network connectivity to Intercom
