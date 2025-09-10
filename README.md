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
   # Required Slack Configuration
   SLACK_CLIENT_ID=your-client-id
   SLACK_CLIENT_SECRET=your-client-secret
   SLACK_SIGNING_SECRET=your-signing-secret
   SLACK_BOT_TOKEN=your-bot-token
   ADMIN_USER_ID=your-user-id
   EXTERNAL_WEBHOOK_TOKEN=your-webhook-token

   # Server Configuration
   PORT=3000
   BASE_URL=https://your-app-name.onrender.com

   # Storage Configuration (choose one)
   # Option 1: GitHub Gist (recommended for Render)
   USE_GIST_STORAGE=true
   GITHUB_TOKEN=ghp_your-github-token
   GIST_ID=your-gist-id

   # Option 2: Local file (development only)
   # USE_GIST_STORAGE=false
   # PERSIST_PATH=./storage.json
   ```

4. **Deploy**: Render will automatically build and deploy

## 💾 Storage Options

### Option 1: GitHub Gist Storage (Recommended for Render)

**Persistent storage using GitHub Gists - perfect for Render deployments:**

1. **Create a GitHub Personal Access Token**:

   - Go to GitHub Settings → Developer settings → Personal access tokens
   - Generate a new token with `gist` scope
   - Copy the token (starts with `ghp_`)

2. **Create a Gist**:

   - Go to https://gist.github.com
   - Create a new secret gist
   - Add a file named `storage.json` with content: `{}`
   - Copy the Gist ID from the URL (e.g., `abc123def456`)

3. **Configure Environment Variables**:
   ```env
   USE_GIST_STORAGE=true
   GITHUB_TOKEN=ghp_your-github-token
   GIST_ID=your-gist-id
   ```

**Benefits:**

- ✅ **Persistent across deployments**
- ✅ **Free and reliable**
- ✅ **Automatic backups**
- ✅ **Version history**

### Option 2: Local File Storage (Development Only)

**File-based storage for local development:**

```env
USE_GIST_STORAGE=false
PERSIST_PATH=./storage.json
```

**Limitations:**

- ⚠️ **Data lost on Render restarts**
- 🔄 **Users need to reconfigure after deployments**

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
