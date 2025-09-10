#!/bin/bash

# Deployment script for GCP VM
# Run this on your VM to update the bot

set -e

echo "🚀 Deploying Slack Bot updates..."

# Navigate to app directory
cd /opt/slack-bot

# Pull latest changes
echo "📥 Pulling latest changes from GitHub..."
git pull origin main

# Install/update dependencies
echo "📦 Installing dependencies..."
npm install --production

# Restart the application
echo "🔄 Restarting application..."
pm2 reload slack-bot

# Show status
echo "✅ Deployment complete!"
pm2 status
