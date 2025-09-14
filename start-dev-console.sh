#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Hypernative Slack Bot with CONSOLE OUTPUT...${NC}"

# Kill any existing processes
echo -e "${YELLOW}🧹 Cleaning up existing processes...${NC}"
pkill -f "node app.js" 2>/dev/null || true
pkill -f "nodemon" 2>/dev/null || true
pkill -f "localtunnel" 2>/dev/null || true
sleep 2

# Start the bot with nodemon for hot-reload (WITH CONSOLE OUTPUT)
echo -e "${PURPLE}🔥 Starting bot with HOT-RELOAD + CONSOLE OUTPUT...${NC}"
echo -e "${YELLOW}   📝 Running: nodemon app.js${NC}"
echo -e "${GREEN}   📺 Console output will be visible here!${NC}"
echo -e "${BLUE}   ⏳ Waiting 3 seconds for bot to initialize...${NC}"
sleep 3

# Start nodemon with console output
npx nodemon app.js &
BOT_PID=$!
echo -e "${BLUE}   🔄 Bot PID: $BOT_PID${NC}"

# Wait for the app to actually start
echo -e "${BLUE}   ⏳ Waiting 5 seconds for app to start...${NC}"
sleep 5

# Check if bot started successfully
echo -e "${BLUE}   🔍 Testing health endpoint...${NC}"
if curl -s http://localhost:3000/healthz > /dev/null; then
    echo -e "${GREEN}✅ Bot started successfully and responding on port 3000${NC}"
    echo -e "${PURPLE}🔥 HOT-RELOAD is active - bot will restart when you save files!${NC}"
    echo -e "${GREEN}📺 Console logs are now visible in this terminal!${NC}"
else
    echo -e "${RED}❌ Failed to start bot on port 3000${NC}"
    kill $BOT_PID 2>/dev/null || true
    exit 1
fi

# Get public IP for localtunnel password
echo -e "${BLUE}🌐 Getting public IP for tunnel password...${NC}"
PUBLIC_IP=$(curl -s https://loca.lt/mytunnelpassword 2>/dev/null || curl -s https://api.ipify.org 2>/dev/null || echo "unknown")
if [ "$PUBLIC_IP" != "unknown" ]; then
    echo -e "${GREEN}   ✅ Public IP: $PUBLIC_IP${NC}"
    echo -e "${YELLOW}   💡 Use this IP as the password when prompted by LocalTunnel${NC}"
else
    echo -e "${YELLOW}   ⚠️  Could not get public IP automatically${NC}"
    echo -e "${YELLOW}   💡 Visit https://loca.lt/mytunnelpassword to get your IP manually${NC}"
fi

# Start localtunnel with fixed subdomain
echo -e "${BLUE}🌐 Starting tunnel...${NC}"
echo -e "${YELLOW}   📝 Running: npx localtunnel --port 3000 --subdomain hypernative-slack-bot${NC}"
npx localtunnel --port 3000 --subdomain hypernative-slack-bot > tunnel.log 2>&1 &
TUNNEL_PID=$!
echo -e "${BLUE}   🔄 Tunnel PID: $TUNNEL_PID${NC}"
echo -e "${BLUE}   ⏳ Waiting 5 seconds for tunnel to establish...${NC}"
sleep 5

# Check if tunnel started and get URL
TUNNEL_URL="https://hypernative-slack-bot.loca.lt"
echo -e "${BLUE}   🔍 Testing tunnel at: $TUNNEL_URL${NC}"
if curl -s "$TUNNEL_URL/healthz" > /dev/null; then
    echo -e "${GREEN}✅ Tunnel active at: $TUNNEL_URL${NC}"
    echo -e "${BLUE}   📋 Tunnel logs available in: tunnel.log${NC}"
else
    echo -e "${YELLOW}⚠️  Fixed subdomain not available, checking tunnel logs...${NC}"
    echo -e "${BLUE}   📋 Tunnel log contents:${NC}"
    cat tunnel.log 2>/dev/null || echo "No tunnel logs available"
    
    echo -e "${YELLOW}   🔄 Trying random subdomain instead...${NC}"
    kill $TUNNEL_PID 2>/dev/null || true
    sleep 2
    
    # Start with random subdomain
    echo -e "${YELLOW}   📝 Running: npx localtunnel --port 3000${NC}"
    npx localtunnel --port 3000 > tunnel.log 2>&1 &
    TUNNEL_PID=$!
    echo -e "${BLUE}   🔄 New tunnel PID: $TUNNEL_PID${NC}"
    echo -e "${BLUE}   ⏳ Waiting 5 seconds for random tunnel...${NC}"
    sleep 5
    
    # Extract URL from log
    echo -e "${BLUE}   📋 Checking tunnel log for URL...${NC}"
    if [ -f tunnel.log ]; then
        echo -e "${BLUE}   📄 Tunnel log contents:${NC}"
        cat tunnel.log
        TUNNEL_URL=$(grep -o 'https://[^[:space:]]*\.loca\.lt' tunnel.log | head -1)
        if [ -n "$TUNNEL_URL" ]; then
            echo -e "${GREEN}✅ Tunnel active at: $TUNNEL_URL${NC}"
            echo -e "${BLUE}   🔍 Testing random tunnel...${NC}"
            if curl -s "$TUNNEL_URL/healthz" > /dev/null; then
                echo -e "${GREEN}✅ Random tunnel responding correctly${NC}"
            else
                echo -e "${YELLOW}⚠️  Tunnel URL found but not responding yet${NC}"
            fi
        else
            echo -e "${RED}❌ Failed to extract tunnel URL from logs${NC}"
            echo -e "${RED}   📋 Full tunnel log:${NC}"
            cat tunnel.log
            kill $BOT_PID $TUNNEL_PID 2>/dev/null || true
            exit 1
        fi
    else
        echo -e "${RED}❌ Tunnel log file not found${NC}"
        kill $BOT_PID $TUNNEL_PID 2>/dev/null || true
        exit 1
    fi
fi

# Update .env with the tunnel URL
echo -e "${BLUE}📝 Updating BASE_URL in environment...${NC}"
echo -e "${BLUE}   🔍 Checking if BASE_URL exists in .env...${NC}"
if grep -q "BASE_URL=" .env; then
    echo -e "${BLUE}   ✏️  Replacing existing BASE_URL...${NC}"
    # Replace existing BASE_URL
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|BASE_URL=.*|BASE_URL=\"$TUNNEL_URL\"|" .env
    else
        sed -i "s|BASE_URL=.*|BASE_URL=\"$TUNNEL_URL\"|" .env
    fi
    echo -e "${GREEN}   ✅ BASE_URL updated in .env${NC}"
else
    echo -e "${BLUE}   ➕ Adding new BASE_URL to .env...${NC}"
    # Add BASE_URL if it doesn't exist
    echo "BASE_URL=\"$TUNNEL_URL\"" >> .env
    echo -e "${GREEN}   ✅ BASE_URL added to .env${NC}"
fi

echo -e "${GREEN}✅ Environment updated with BASE_URL=$TUNNEL_URL${NC}"
echo -e "${BLUE}   📄 Current .env BASE_URL:${NC}"
grep "BASE_URL=" .env || echo "   No BASE_URL found"

# Display information
echo -e "\n${GREEN}🎉 CONSOLE OUTPUT Development Setup Complete!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Bot URL:${NC} http://localhost:3000"
echo -e "${GREEN}Public URL:${NC} $TUNNEL_URL"
echo -e "${GREEN}Health Check:${NC} $TUNNEL_URL/healthz"
echo -e "${GREEN}Webhook Endpoint:${NC} $TUNNEL_URL/webhook/{user-token}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "\n${YELLOW}📋 Update your Slack app configuration:${NC}"
echo -e "   • Interactivity & Shortcuts: $TUNNEL_URL/slack/events"
echo -e "   • Event Subscriptions: $TUNNEL_URL/slack/events"
echo -e "   • Slash Commands: $TUNNEL_URL/slack/events"
echo -e "   • OAuth Redirect URL: $TUNNEL_URL/slack/oauth_redirect"
echo -e "   • Installation URL: $TUNNEL_URL/slack/install"
echo -e "   • App Home: $TUNNEL_URL/slack/events"

if [ "$PUBLIC_IP" != "unknown" ]; then
    echo -e "\n${YELLOW}🔐 LocalTunnel Password:${NC}"
    echo -e "   • Password: $PUBLIC_IP"
    echo -e "   • Enter this when prompted by LocalTunnel"
fi
echo -e "\n${PURPLE}🔥 CONSOLE OUTPUT FEATURES:${NC}"
echo -e "   • Bot automatically restarts when you save .js files"
echo -e "   • Tunnel stays active during restarts"
echo -e "   • Console logs are visible in this terminal!"
echo -e "   • Perfect for debugging app_home_opened events!"
echo -e "\n${BLUE}💡 Press Ctrl+C to stop both bot and tunnel${NC}"

# Function to handle cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}🛑 Shutting down development environment...${NC}"
    kill $BOT_PID $TUNNEL_PID 2>/dev/null || true
    pkill -f "nodemon" 2>/dev/null || true
    pkill -f "node app.js" 2>/dev/null || true
    pkill -f "localtunnel" 2>/dev/null || true
    echo -e "${GREEN}✅ Cleanup complete${NC}"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Keep the script running and monitor tunnel process
echo -e "${BLUE}🔄 Starting tunnel monitoring loop...${NC}"
MONITOR_COUNT=0
while true; do
    MONITOR_COUNT=$((MONITOR_COUNT + 1))
    
    # Show monitoring status every 60 seconds (6 iterations * 10 seconds)
    if [ $((MONITOR_COUNT % 6)) -eq 0 ]; then
        echo -e "${BLUE}🔍 Tunnel health check #$((MONITOR_COUNT / 6))...${NC}"
        echo -e "${BLUE}   Tunnel PID: $TUNNEL_PID${NC}"
        echo -e "${PURPLE}   🔥 Bot is managed by nodemon (auto-restart on file changes)${NC}"
        echo -e "${GREEN}   📺 Console logs are visible in this terminal!${NC}"
    fi
    
    # Only monitor tunnel (nodemon handles the bot)
    if ! kill -0 $TUNNEL_PID 2>/dev/null; then
        echo -e "${RED}❌ Tunnel process ($TUNNEL_PID) died, restarting...${NC}"
        echo -e "${BLUE}   📋 Last tunnel log entries:${NC}"
        tail -5 tunnel.log 2>/dev/null || echo "   No tunnel logs available"
        echo -e "${BLUE}   🔄 Restarting tunnel...${NC}"
        npx localtunnel --port 3000 --subdomain hypernative-slack-bot > tunnel.log 2>&1 &
        TUNNEL_PID=$!
        echo -e "${GREEN}   ✅ Tunnel restarted with PID: $TUNNEL_PID${NC}"
        sleep 5
        
        # Test if tunnel is responding
        if curl -s "$TUNNEL_URL/healthz" > /dev/null; then
            echo -e "${GREEN}   ✅ Restarted tunnel is responding${NC}"
        else
            echo -e "${YELLOW}   ⚠️  Restarted tunnel not responding yet${NC}"
        fi
    fi
    
    sleep 10
done
