#!/bin/bash

# GCP VM Setup Script for Slack Bot
# Run this script on your Ubuntu VM

set -e

echo "🚀 Setting up Slack Bot on GCP VM..."

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 18 LTS
echo "📦 Installing Node.js 18 LTS..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Install nginx for reverse proxy
echo "📦 Installing Nginx..."
sudo apt install -y nginx

# Install certbot for SSL certificates
echo "📦 Installing Certbot for SSL..."
sudo apt install -y certbot python3-certbot-nginx

# Create app directory
echo "📁 Creating application directory..."
sudo mkdir -p /opt/slack-bot
sudo chown $USER:$USER /opt/slack-bot
cd /opt/slack-bot

# Clone repository
echo "📥 Cloning repository..."
git clone https://github.com/zeari/slack-bot.git .

# Install dependencies
echo "📦 Installing Node.js dependencies..."
npm install

# Create .env file template
echo "📝 Creating .env template..."
cat > .env << 'EOL'
SLACK_CLIENT_ID="your-client-id"
SLACK_CLIENT_SECRET="your-client-secret"
SLACK_SIGNING_SECRET="your-signing-secret"
SLACK_BOT_TOKEN="your-bot-token"
ADMIN_USER_ID="your-user-id"
EXTERNAL_WEBHOOK_TOKEN="your-webhook-token"
PORT=3000
PERSIST_PATH="./storage.json"
BASE_URL="https://your-domain.com"
EOL

echo "⚙️  Please edit /opt/slack-bot/.env with your actual values"

# Configure nginx
echo "🌐 Configuring Nginx..."
sudo tee /etc/nginx/sites-available/slack-bot > /dev/null << 'EOL'
server {
    listen 80;
    server_name your-domain.com;  # Replace with your domain

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOL

# Enable nginx site
sudo ln -sf /etc/nginx/sites-available/slack-bot /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# Configure PM2
echo "🔄 Configuring PM2..."
cat > ecosystem.config.js << 'EOL'
module.exports = {
  apps: [{
    name: 'slack-bot',
    script: 'app.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true
  }]
};
EOL

# Create logs directory
mkdir -p logs

echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "1. Edit /opt/slack-bot/.env with your Slack app credentials"
echo "2. Replace 'your-domain.com' in /etc/nginx/sites-available/slack-bot"
echo "3. Point your domain to this VM's external IP"
echo "4. Run: sudo certbot --nginx -d your-domain.com"
echo "5. Start the bot: pm2 start ecosystem.config.js"
echo "6. Save PM2 config: pm2 save && pm2 startup"
echo ""
echo "🔗 VM External IP: $(curl -s https://api.ipify.org)"
