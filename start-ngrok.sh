#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Hypernative Slack Bot with ngrok...${NC}"

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
    echo -e "${RED}❌ ngrok is not installed${NC}"
    echo -e "${YELLOW}   Install with: npm install -g ngrok${NC}"
    echo -e "${YELLOW}   Or visit: https://ngrok.com/download${NC}"
    exit 1
fi

# Kill any existing processes
echo -e "${YELLOW}🧹 Cleaning up existing processes...${NC}"
pkill -f "node app.js" 2>/dev/null || true
pkill -f "nodemon" 2>/dev/null || true
pkill -f "ngrok" 2>/dev/null || true
sleep 2

# Start the bot with nodemon for hot-reload
echo -e "${PURPLE}🔥 Starting bot with HOT-RELOAD (nodemon)...${NC}"
echo -e "${YELLOW}   📝 Running: nodemon app.js${NC}"
nodemon app.js > bot.log 2>&1 &
BOT_PID=$!
echo -e "${BLUE}   🔄 Bot PID: $BOT_PID${NC}"
echo -e "${BLUE}   ⏳ Waiting 3 seconds for bot to initialize...${NC}"
sleep 3

# Check if bot started successfully
echo -e "${BLUE}   🔍 Testing health endpoint...${NC}"
if curl -s http://localhost:3000/healthz > /dev/null; then
    echo -e "${GREEN}✅ Bot started successfully and responding on port 3000${NC}"
    echo -e "${PURPLE}🔥 HOT-RELOAD is active - bot will restart when you save files!${NC}"
    echo -e "${BLUE}   📋 Bot logs available in: bot.log${NC}"
else
    echo -e "${RED}❌ Failed to start bot on port 3000${NC}"
    echo -e "${RED}   📋 Bot logs:${NC}"
    tail -10 bot.log 2>/dev/null || echo "No bot logs available"
    kill $BOT_PID 2>/dev/null || true
    exit 1
fi

# Start ngrok
echo -e "${BLUE}🌐 Starting ngrok tunnel...${NC}"
echo -e "${YELLOW}   📝 Running: ngrok http 3000${NC}"
ngrok http 3000 > ngrok.log 2>&1 &
NGROK_PID=$!
echo -e "${BLUE}   🔄 ngrok PID: $NGROK_PID${NC}"
echo -e "${BLUE}   ⏳ Waiting 5 seconds for ngrok to establish...${NC}"
sleep 5

# Get ngrok URL from API
echo -e "${BLUE}   🔍 Getting ngrok URL...${NC}"
NGROK_URL=$(curl -s http://localhost:4040/api/tunnels | grep -o '"public_url":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$NGROK_URL" ]; then
    echo -e "${GREEN}✅ ngrok tunnel active at: $NGROK_URL${NC}"
    echo -e "${BLUE}   📋 ngrok logs available in: ngrok.log${NC}"
    
    # Test the tunnel
    echo -e "${BLUE}   🔍 Testing ngrok tunnel...${NC}"
    if curl -s "$NGROK_URL/healthz" > /dev/null; then
        echo -e "${GREEN}✅ ngrok tunnel responding correctly${NC}"
    else
        echo -e "${YELLOW}⚠️  ngrok tunnel not responding yet (may need a moment)${NC}"
    fi
else
    echo -e "${RED}❌ Failed to get ngrok URL${NC}"
    echo -e "${RED}   📋 ngrok log contents:${NC}"
    cat ngrok.log 2>/dev/null || echo "No ngrok logs available"
    kill $BOT_PID $NGROK_PID 2>/dev/null || true
    exit 1
fi

# Update .env with the ngrok URL
echo -e "${BLUE}📝 Updating BASE_URL in environment...${NC}"
echo -e "${BLUE}   🔍 Checking if BASE_URL exists in .env...${NC}"
if grep -q "BASE_URL=" .env; then
    echo -e "${BLUE}   ✏️  Replacing existing BASE_URL...${NC}"
    # Replace existing BASE_URL
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|BASE_URL=.*|BASE_URL=\"$NGROK_URL\"|" .env
    else
        sed -i "s|BASE_URL=.*|BASE_URL=\"$NGROK_URL\"|" .env
    fi
    echo -e "${GREEN}   ✅ BASE_URL updated in .env${NC}"
else
    echo -e "${BLUE}   ➕ Adding new BASE_URL to .env...${NC}"
    # Add BASE_URL if it doesn't exist
    echo "BASE_URL=\"$NGROK_URL\"" >> .env
    echo -e "${GREEN}   ✅ BASE_URL added to .env${NC}"
fi

echo -e "${GREEN}✅ Environment updated with BASE_URL=$NGROK_URL${NC}"
echo -e "${BLUE}   📄 Current .env BASE_URL:${NC}"
grep "BASE_URL=" .env || echo "   No BASE_URL found"

# Display information
echo -e "\n${GREEN}🎉 ngrok Development Setup Complete!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}Bot URL:${NC} http://localhost:3000"
echo -e "${GREEN}Public URL:${NC} $NGROK_URL"
echo -e "${GREEN}Health Check:${NC} $NGROK_URL/healthz"
echo -e "${GREEN}Webhook Endpoint:${NC} $NGROK_URL/webhook/{user-token}"
echo -e "${GREEN}ngrok Dashboard:${NC} http://localhost:4040"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "\n${YELLOW}📋 Update your Slack app configuration:${NC}"
echo -e "   • Interactivity & Shortcuts: $NGROK_URL/slack/events"
echo -e "   • Event Subscriptions: $NGROK_URL/slack/events"
echo -e "   • Slash Commands: $NGROK_URL/slack/events"
echo -e "   • OAuth Redirect URL: $NGROK_URL/slack/oauth_redirect"
echo -e "   • Installation URL: $NGROK_URL/slack/install"
echo -e "   • App Home: $NGROK_URL/slack/events"
echo -e "\n${PURPLE}🔥 HOT-RELOAD FEATURES:${NC}"
echo -e "   • Bot automatically restarts when you save .js files"
echo -e "   • Tunnel stays active during restarts"
echo -e "   • Logs are preserved and updated in real-time"
echo -e "   • No password required for ngrok!"
echo -e "\n${BLUE}💡 Press Ctrl+C to stop both bot and tunnel${NC}"

# Function to handle cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}🛑 Shutting down development environment...${NC}"
    kill $BOT_PID $NGROK_PID 2>/dev/null || true
    pkill -f "nodemon" 2>/dev/null || true
    pkill -f "node app.js" 2>/dev/null || true
    pkill -f "ngrok" 2>/dev/null || true
    echo -e "${GREEN}✅ Cleanup complete${NC}"
    exit 0
}

# Set up signal handlers
trap cleanup SIGINT SIGTERM

# Keep the script running and monitor processes
echo -e "${BLUE}🔄 Starting monitoring loop...${NC}"
MONITOR_COUNT=0
while true; do
    MONITOR_COUNT=$((MONITOR_COUNT + 1))
    
    # Show monitoring status every 60 seconds (6 iterations * 10 seconds)
    if [ $((MONITOR_COUNT % 6)) -eq 0 ]; then
        echo -e "${BLUE}🔍 Health check #$((MONITOR_COUNT / 6))...${NC}"
        echo -e "${BLUE}   Bot PID: $BOT_PID${NC}"
        echo -e "${BLUE}   ngrok PID: $NGROK_PID${NC}"
        echo -e "${PURPLE}   🔥 Bot is managed by nodemon (auto-restart on file changes)${NC}"
    fi
    
    # Monitor both processes
    if ! kill -0 $BOT_PID 2>/dev/null; then
        echo -e "${RED}❌ Bot process ($BOT_PID) died${NC}"
        echo -e "${BLUE}   📋 Last bot log entries:${NC}"
        tail -5 bot.log 2>/dev/null || echo "   No bot logs available"
    fi
    
    if ! kill -0 $NGROK_PID 2>/dev/null; then
        echo -e "${RED}❌ ngrok process ($NGROK_PID) died, restarting...${NC}"
        echo -e "${BLUE}   📋 Last ngrok log entries:${NC}"
        tail -5 ngrok.log 2>/dev/null || echo "   No ngrok logs available"
        echo -e "${BLUE}   🔄 Restarting ngrok...${NC}"
        ngrok http 3000 > ngrok.log 2>&1 &
        NGROK_PID=$!
        echo -e "${GREEN}   ✅ ngrok restarted with PID: $NGROK_PID${NC}"
        sleep 5
    fi
    
    sleep 10
done
