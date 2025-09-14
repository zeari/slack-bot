// Main application file - refactored and modularized
import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import express from "express";
import {
  PORT,
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  AUTO_SAVE_INTERVAL,
} from "./src/config/index.js";
import {
  initializeStorage,
  updateStore,
  updateStoreWithChangeDetection,
} from "./src/services/storage.js";
import { CustomInstallationStore } from "./src/services/installationStore.js";
import { setupInstallRoutes } from "./src/handlers/install.js";
import { setupWebhookRoutes } from "./src/handlers/webhooks.js";
import { setupMessageHandlers } from "./src/handlers/messages.js";
import { setupAppHomeHandler } from "./src/handlers/appHome.js";
import { setupCommandHandlers } from "./src/handlers/commands.js";

// Track which workspaces the bot is installed in and their tokens
let workspaceTokens = new Map(); // { teamId: { token, team, bot, user, scopes } }

// Sync workspace tokens from storage
function syncWorkspaceTokens(store) {
  workspaceTokens.clear();

  for (const [teamId, installation] of Object.entries(store.installations)) {
    workspaceTokens.set(teamId, {
      token: installation.token,
      team: installation.team,
      bot: installation.bot,
      user: installation.userId,
      scopes: installation.scopes,
      installedAt: installation.installedAt,
    });
  }

  console.log(
    `🔄 Synced ${workspaceTokens.size} workspace tokens from storage`
  );
}

// ---- Bolt receiver (so we can mount custom Express routes) ----
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

// Initialize the custom installation store (will be set up after storage is loaded)
let installationStore = null;

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
  // Socket Mode not used because we expose a webhook
  // installationStore will be set after storage is initialized
});

// Add diagnostic middleware to identify token/workspace mismatches
app.use(async ({ client, event, context, next }) => {
  try {
    const auth = await client.auth.test(); // token actually used for this handler
    console.log(
      "🔎 auth.test token team_id:",
      auth.team_id,
      "user_id:",
      auth.user_id
    );
    console.log(
      "🔎 event.team:",
      event?.team,
      "context.teamId:",
      context?.teamId
    );
    console.log(
      "🔎 event.channel:",
      event?.channel,
      "channel_type:",
      event?.channel_type
    );

    // Check for token/workspace mismatch
    const eventTeam = event?.team || context?.teamId;
    if (auth.team_id !== eventTeam) {
      console.log("⚠️ TOKEN MISMATCH: auth.team_id !== event.team");
      console.log("⚠️ This will cause channel_not_found errors in DMs!");
    } else {
      console.log("✅ Token match: auth.team_id === event.team");
    }
  } catch (e) {
    console.log("🔎 auth.test failed:", e?.data || e?.message);
  }
  await next();
});

// Add general event logging for debugging
app.event(/.*/, async ({ event, client }) => {
  console.log("📨 Event received:", event.type, "at", new Date().toISOString());
});

// Initialize storage
let STORE = null;

// Periodic auto-save to prevent data loss
let lastSaveTime = Date.now();

setInterval(async () => {
  try {
    const now = Date.now();
    if (now - lastSaveTime >= AUTO_SAVE_INTERVAL) {
      await updateStoreWithChangeDetection(
        STORE,
        (store) => {},
        "periodic backup"
      );
      lastSaveTime = now;
      console.log(
        `🔄 Periodic backup completed at ${new Date().toISOString()} (every 5 minutes)`
      );
    }
  } catch (error) {
    console.error(`❌ Periodic backup failed:`, error);
  }
}, AUTO_SAVE_INTERVAL);

// Graceful shutdown handlers
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, saving data before exit...");
  try {
    await updateStore(STORE, (store) => {});
    console.log("✅ Data saved successfully");
  } catch (error) {
    console.error("❌ Failed to save data on exit:", error);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, saving data before exit...");
  try {
    await updateStore(STORE, (store) => {});
    console.log("✅ Data saved successfully");
  } catch (error) {
    console.error("❌ Failed to save data on exit:", error);
  }
  process.exit(0);
});

// Handle uncaught exceptions - save data but don't crash
process.on("uncaughtException", async (error) => {
  console.error("❌ Uncaught Exception:", error);
  try {
    await updateStore(STORE, (store) => {});
    console.log("✅ Data saved after error");
  } catch (saveError) {
    console.error("❌ Failed to save data after error:", saveError);
  }
  console.log("🔄 Bot continuing to run despite error...");
});

// Handle unhandled promise rejections - save data but don't crash
process.on("unhandledRejection", async (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  try {
    await updateStore(STORE, (store) => {});
    console.log("✅ Data saved after rejection");
  } catch (saveError) {
    console.error("❌ Failed to save data after rejection:", saveError);
  }
  console.log("🔄 Bot continuing to run despite rejection...");
});

// Setup all handlers
function setupHandlers() {
  // Setup route handlers
  setupInstallRoutes(
    receiver,
    STORE,
    updateStoreWithChangeDetection,
    workspaceTokens,
    installationStore
  );
  setupWebhookRoutes(
    receiver,
    app,
    STORE,
    updateStoreWithChangeDetection,
    installationStore
  );

  // Setup Slack handlers
  setupMessageHandlers(app, STORE, updateStoreWithChangeDetection);
  setupAppHomeHandler(
    app,
    STORE,
    updateStoreWithChangeDetection,
    workspaceTokens
  );
  setupCommandHandlers(
    app,
    STORE,
    updateStoreWithChangeDetection,
    workspaceTokens
  );
}

// Health check with storage status
receiver.router.get("/healthz", (req, res) => {
  const storageStats = {
    destinations: Object.keys(STORE.destinations).length,
    userTokens: Object.keys(STORE.userTokens).length,
    tokenMappings: Object.keys(STORE.tokenToUser).length,
    installations: Object.keys(STORE.installations).length,
    workspaceTokens: workspaceTokens.size,
    installedWorkspaces: Array.from(workspaceTokens.keys()),
    lastSave: lastSaveTime,
    storagePath: process.env.PERSIST_PATH || "./storage.json",
  };

  res.json({
    status: "ok",
    storage: storageStats,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// Main startup function
(async () => {
  console.log(`🚀 Starting Hypernative Slack Bot...`);
  console.log(`📝 Configuration:`);
  console.log(`   Port: ${PORT}`);
  console.log(
    `   Base URL: ${process.env.BASE_URL || "http://localhost:3000"}`
  );
  console.log(`   Admin User: ${process.env.ADMIN_USER_ID}`);
  console.log(
    `   Storage: ${
      process.env.USE_GIST_STORAGE === "true"
        ? `GitHub Gist (${process.env.GIST_ID})`
        : `Local file (${process.env.PERSIST_PATH || "./storage.json"})`
    }`
  );

  // Initialize storage first
  try {
    STORE = await initializeStorage();
    console.log(`📂 Storage initialized successfully`);

    // Initialize the custom installation store
    installationStore = new CustomInstallationStore(
      STORE,
      updateStoreWithChangeDetection
    );

    // Configure the app with the installation store using authorize function
    app.authorize = async ({ teamId, enterpriseId, userId }) => {
      console.log(
        `🔐 Authorizing request for team: ${teamId}, user: ${userId}`
      );

      const installation = await installationStore.fetchInstallation({
        teamId,
        enterpriseId,
      });

      if (!installation) {
        console.log(`❌ No installation found for team: ${teamId}`);
        return false;
      }

      console.log(`✅ Authorization successful for team: ${teamId}`);
      return {
        botToken: installation.bot?.token,
        userToken: installation.user?.token,
        botId: installation.bot?.id,
        botUserId: installation.bot?.userId,
        teamId: installation.team?.id,
        enterpriseId: installation.enterprise?.id,
        isEnterpriseInstall: installation.isEnterpriseInstall,
      };
    };

    // Sync workspace tokens from storage
    syncWorkspaceTokens(STORE);
  } catch (error) {
    console.error(`❌ Failed to initialize storage:`, error);
    process.exit(1);
  }

  // Setup all handlers
  setupHandlers();

  try {
    await app.start(PORT);
    console.log(
      `⚡️ Hypernative Slack Bot successfully started on port ${PORT}`
    );
    console.log(`🔗 Health endpoint: http://localhost:${PORT}/healthz`);
    console.log(
      `🎯 Webhook endpoint: http://localhost:${PORT}/webhook/{user-token}`
    );
    console.log(
      `📊 Legacy webhook: http://localhost:${PORT}/hypernative/webhook`
    );
    console.log(`✅ Bot is ready to receive Slack events!`);
    console.log(
      `🔥 HOT-RELOAD is active - save files to restart automatically!`
    );
  } catch (error) {
    console.error(`❌ Failed to start bot:`, error);
    console.log(`🔄 Attempting to restart in 5 seconds...`);

    // Retry starting the bot after a delay
    setTimeout(async () => {
      try {
        await app.start(PORT);
        console.log(`✅ Bot successfully restarted on port ${PORT}`);
      } catch (retryError) {
        console.error(`❌ Retry failed:`, retryError);
        console.log(`🔄 Will continue trying to start...`);
      }
    }, 5000);
  }
})();
