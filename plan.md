# Discord Feedback Bot - Tickets v2 Integration

## Overview
Add feedback module to existing Discord-intercome bot that:
- Captures feedback via **Tickets v2 form** (separate feedback ticket type)
- Stores in **Google Sheets** (deduplication, metadata)
- Detects duplicates from Intercom + Tickets v2
- **Mod approval workflow** in Discord before posting to Slack
- Public **Discord dashboard** showing: Forwarded to Team | Working On It | Not Planned
- Posts approved feedback to **Slack #feedback-river**

## Flow
1. User submits feedback form (Tickets v2)
2. Bot receives form → checks duplicates in Sheets + Intercom
3. If new/unique: adds to Sheets with "pending" status
4. Mod approves in Discord → updates status → posts to Slack
5. Dashboard shows statuses: Forwarded to Team, Working On It, Not Planned

## Steps

### [x] Step 1: Setup Google Sheets Integration
- `feedback.js` - FeedbackManager class handles all Google Sheets operations
- Read/write feedback records with proper headers
- Automatic sheet creation and validation

### [x] Step 2: Duplicate Detection Engine
- `feedback.js` - DuplicateDetector class with exact match and semantic similarity
- Checks both Google Sheets + Intercom tickets
- Returns similarity scores and matching feedback

### [x] Step 3: Tickets v2 Webhook Handler
- `api.js` + `feedback-handler.js` - Complete webhook receiver
- Extracts form data, email, user ID from Tickets v2 forms
- Runs duplicate detection on submission
- Adds to Sheets with "pending" status
- Notifies mods with similar feedback list

### [x] Step 4: Intercom Feedback Consolidation
- `feedback-handler.js` - checkIntercomDuplicates() method
- Queries Intercom API for existing tickets
- Filters and matches against new feedback

### [x] Step 5: Mod Approval Workflow in Discord
- `discord-bot.js` + `feedback-handler.js` - Reaction-based approval
- Embeds posted to MOD_CHANNEL_ID (mod-only)
- Reactions: ✅ approve, ❌ reject, 🏗️ working on it
- Updates Sheets status on reaction

### [x] Step 6: Slack Integration
- `feedback-handler.js` - postToSlack() method
- Posts approved feedback to Slack webhook
- Includes feedback text, duplicate count, user email

### [x] Step 7: Public Discord Dashboard
- `feedback-handler.js` - updatePublicDashboard() method
- Embeds showing: Forwarded to Team | Working On It | Not Planned
- Displays duplicate counts per feedback
- Updates on-demand via API endpoint

### [x] Step 8: Deployment & Testing
- All code ready for Discord-intercome repo integration
- Files: api.js, discord-bot.js, feedback.js, feedback-handler.js, start.js
- .env.example and SETUP.md with configuration guide
- Ready for Render deployment
