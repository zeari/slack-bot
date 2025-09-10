# Hypernative Slack Bot

A Slack bot for receiving and managing Hypernative security alerts.

## 🚀 Quick Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

### Manual Deployment

1. **Fork/Clone this repository**
2. **Connect to Render**:
   - Go to [render.com](https://render.com)
   - Create a new Web Service
   - Connect your GitHub repository
3. **Configure Environment Variables**:
   ```env
   SLACK_CLIENT_ID=your-client-id
   SLACK_CLIENT_SECRET=your-client-secret
   SLACK_SIGNING_SECRET=your-signing-secret
   SLACK_BOT_TOKEN=your-bot-token
   ADMIN_USER_ID=your-user-id
   EXTERNAL_WEBHOOK_TOKEN=your-webhook-token
   PORT=3000
   PERSIST_PATH=./storage.json
   BASE_URL=https://your-app-name.onrender.com
   ```
4. **Deploy**: Render will automatically build and deploy

## ⚠️ Important: Storage Behavior

**This bot uses file-based storage (`storage.json`) which is ephemeral on Render:**

- ✅ **Works perfectly** during normal operation
- ⚠️ **Data is lost** when the app restarts/redeploys
- 🔄 **Easy recovery**: Users just need to reconfigure their webhook URLs

**What gets lost on restart:**
- User webhook URLs and channel configurations
- Installation data for additional workspaces

**What doesn't get lost:**
- Your Slack app configuration
- The bot's core functionality

## 🔧 Post-Deployment Setup

1. **Update Slack App URLs** at https://api.slack.com/apps:
   - **Interactivity**: `https://your-app.onrender.com/slack/events`
   - **Event Subscriptions**: `https://your-app.onrender.com/slack/events`
   - **Slash Commands**: `https://your-app.onrender.com/slack/events`
   - **OAuth Redirect**: `https://your-app.onrender.com/slack/oauth_redirect`

2. **Share Installation URL**:
   ```
   https://your-app.onrender.com/slack/install
   ```

## 📋 Features

- ✅ Multi-user webhook URLs
- ✅ Channel-specific alert routing
- ✅ Accept/Deny action buttons
- ✅ Multi-workspace installation support
- ✅ Conversational setup (DMs and mentions)
- ✅ Slash command configuration
- ✅ App Home tab interface

## 🔗 Endpoints

- **Health Check**: `/healthz`
- **User Webhooks**: `/webhook/{user-token}`
- **Legacy Webhook**: `/hypernative/webhook`
- **Installation**: `/slack/install`
- **OAuth Callback**: `/slack/oauth_redirect`

## 💡 Usage

1. **Install the bot** in your Slack workspace
2. **Configure your channel**: Say "hi" to the bot or use `/hypernative-config`
3. **Get your webhook URL**: The bot will provide a unique URL for you
4. **Configure Hypernative**: Use your webhook URL in Hypernative settings
5. **Receive alerts**: Alerts will appear in your configured channel with action buttons

## 🛠️ Development

```bash
# Install dependencies
npm install

# Start development server with hot reload
npm run dev

# Start with tunnel for Slack testing
npm run dev:hot
```

## 📦 Dependencies

- `@slack/bolt` - Slack Bot framework
- `express` - Web server
- `dotenv` - Environment variables

## 🔒 Security

- All webhook URLs are unique per user
- External webhook requires authentication token
- Slack signing secret validation
- OAuth 2.0 for multi-workspace installation
