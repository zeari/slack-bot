// app.js
// A Slack bot (Bolt + Express) that receives Hypernative-style POSTs and posts an actionable message
// with Accept/Deny buttons. Includes first-run onboarding to choose a destination thread.

import dotenv from "dotenv";
dotenv.config();
import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Env ----
const PORT = process.env.PORT || 3000;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID;
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID; // e.g., U012ABCDEF — the person to prompt on first run
const EXTERNAL_WEBHOOK_TOKEN = process.env.EXTERNAL_WEBHOOK_TOKEN; // simple bearer for /hypernative/webhook
const PERSIST_PATH =
  process.env.PERSIST_PATH || path.join(__dirname, "storage.json");

if (
  !SLACK_SIGNING_SECRET ||
  !SLACK_BOT_TOKEN ||
  !ADMIN_USER_ID ||
  !EXTERNAL_WEBHOOK_TOKEN
) {
  console.error(
    "Missing env vars. Required: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, ADMIN_USER_ID, EXTERNAL_WEBHOOK_TOKEN"
  );
  console.error(
    "Optional for multi-workspace: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET"
  );
  process.exit(1);
}

// ---- Tiny persistence (JSON file) ----
function loadStore() {
  console.log(`📂 Loading storage from: ${PERSIST_PATH}`);

  try {
    const raw = fs.readFileSync(PERSIST_PATH, "utf8");
    const parsed = JSON.parse(raw);

    // Ensure all required fields exist (backward compatibility)
    const store = {
      destinations: parsed.destinations || {},
      userTokens: parsed.userTokens || {},
      tokenToUser: parsed.tokenToUser || {},
      installations: parsed.installations || {},
    };

    console.log(
      `📂 ✅ Loaded storage: ${
        Object.keys(store.userTokens).length
      } user tokens, ${Object.keys(store.destinations).length} destinations`
    );
    console.log(
      `📂 Available user tokens: ${Object.keys(store.userTokens).join(", ")}`
    );
    return store;
  } catch (e) {
    console.log(
      `📂 ❌ Failed to load storage from ${PERSIST_PATH}: ${e.message}`
    );
    console.log(`📂 Creating new storage file at ${PERSIST_PATH}`);
    const newStore = {
      destinations: {}, // { [userId]: { channel: 'C..' } }
      userTokens: {}, // { [userId]: 'unique-token' }
      tokenToUser: {}, // { 'unique-token': userId } - reverse lookup
      installations: {}, // { [teamId]: installation data }
    };

    // Try to save the new store to verify the path works
    try {
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(newStore, null, 2));
      console.log(`📂 ✅ Created new storage file successfully`);
    } catch (saveError) {
      console.log(`📂 ❌ Failed to create storage file: ${saveError.message}`);
    }

    return newStore;
  }
}
function saveStore(store) {
  try {
    // Create backup before saving
    if (fs.existsSync(PERSIST_PATH)) {
      const backupPath = `${PERSIST_PATH}.backup`;
      fs.copyFileSync(PERSIST_PATH, backupPath);
    }

    // Write to temporary file first, then rename (atomic operation)
    const tempPath = `${PERSIST_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2));
    fs.renameSync(tempPath, PERSIST_PATH);

    console.log(`💾 Storage saved successfully to ${PERSIST_PATH}`);
  } catch (error) {
    console.error(`❌ Failed to save storage:`, error);
    // Try to restore from backup if main save failed
    const backupPath = `${PERSIST_PATH}.backup`;
    if (fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(backupPath, PERSIST_PATH);
        console.log(`🔄 Restored from backup: ${backupPath}`);
      } catch (restoreError) {
        console.error(`❌ Failed to restore from backup:`, restoreError);
      }
    }
    throw error;
  }
}
let STORE = loadStore();

// Validate and repair storage data
function validateStorage(store) {
  let needsRepair = false;

  // Ensure all required fields exist
  if (!store.destinations || typeof store.destinations !== "object") {
    store.destinations = {};
    needsRepair = true;
  }

  if (!store.userTokens || typeof store.userTokens !== "object") {
    store.userTokens = {};
    needsRepair = true;
  }

  if (!store.tokenToUser || typeof store.tokenToUser !== "object") {
    store.tokenToUser = {};
    needsRepair = true;
  }

  if (!store.installations || typeof store.installations !== "object") {
    store.installations = {};
    needsRepair = true;
  }

  // Validate token mappings consistency
  const orphanedTokens = [];
  for (const [token, userId] of Object.entries(store.tokenToUser)) {
    if (!store.userTokens[userId] || store.userTokens[userId] !== token) {
      orphanedTokens.push(token);
    }
  }

  // Remove orphaned tokens
  orphanedTokens.forEach((token) => {
    delete store.tokenToUser[token];
    needsRepair = true;
  });

  // Validate user tokens consistency
  const orphanedUsers = [];
  for (const [userId, token] of Object.entries(store.userTokens)) {
    if (!store.tokenToUser[token] || store.tokenToUser[token] !== userId) {
      orphanedUsers.push(userId);
    }
  }

  // Remove orphaned users
  orphanedUsers.forEach((userId) => {
    delete store.userTokens[userId];
    needsRepair = true;
  });

  if (needsRepair) {
    console.log("🔧 Storage validation found issues, repairing...");
    saveStore(store);
    console.log("✅ Storage repaired successfully");
  } else {
    console.log("✅ Storage validation passed");
  }

  return store;
}

// Validate storage on startup
STORE = validateStorage(STORE);

// Safe storage update function that automatically saves
function updateStore(updateFn) {
  try {
    updateFn(STORE);
    saveStore(STORE);
  } catch (error) {
    console.error(`❌ Failed to update storage:`, error);
    throw error;
  }
}

// Periodic auto-save to prevent data loss
let lastSaveTime = Date.now();
const AUTO_SAVE_INTERVAL = 30000; // 30 seconds

setInterval(() => {
  try {
    const now = Date.now();
    if (now - lastSaveTime >= AUTO_SAVE_INTERVAL) {
      saveStore(STORE);
      lastSaveTime = now;
      console.log(`🔄 Auto-save completed at ${new Date().toISOString()}`);
    }
  } catch (error) {
    console.error(`❌ Auto-save failed:`, error);
  }
}, AUTO_SAVE_INTERVAL);

// Graceful shutdown handler
process.on("SIGINT", () => {
  console.log("\n🛑 Received SIGINT, saving data before exit...");
  try {
    saveStore(STORE);
    console.log("✅ Data saved successfully");
  } catch (error) {
    console.error("❌ Failed to save data on exit:", error);
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Received SIGTERM, saving data before exit...");
  try {
    saveStore(STORE);
    console.log("✅ Data saved successfully");
  } catch (error) {
    console.error("❌ Failed to save data on exit:", error);
  }
  process.exit(0);
});

// Handle uncaught exceptions - save data but don't crash
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  try {
    saveStore(STORE);
    console.log("✅ Data saved after error");
  } catch (saveError) {
    console.error("❌ Failed to save data after error:", saveError);
  }
  console.log("🔄 Bot continuing to run despite error...");
});

// Handle unhandled promise rejections - save data but don't crash
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  try {
    saveStore(STORE);
    console.log("✅ Data saved after rejection");
  } catch (saveError) {
    console.error("❌ Failed to save data after rejection:", saveError);
  }
  console.log("🔄 Bot continuing to run despite rejection...");
});

// ---- Bolt receiver (so we can mount custom Express routes) ----
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
  // Socket Mode not used because we expose a webhook
});

// --- Helpers ---
const fmtUTC = (iso) => {
  try {
    if (!iso) return "Unknown time";
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").replace("Z", " UTC");
  } catch {
    return iso;
  }
};

function getUserToken(userId) {
  // Ensure backward compatibility with existing storage
  if (!STORE.userTokens) STORE.userTokens = {};
  if (!STORE.tokenToUser) STORE.tokenToUser = {};

  if (STORE.userTokens[userId]) {
    return STORE.userTokens[userId];
  }

  // Generate new token for user
  const token = randomUUID();
  updateStore((store) => {
    store.userTokens[userId] = token;
    store.tokenToUser[token] = userId;
  });

  return token;
}

function getUserWebhookURL(userId, baseURL) {
  const token = getUserToken(userId);
  // Default to localhost for development, but allow override
  const defaultURL = process.env.BASE_URL || "http://localhost:3000";
  const finalURL = baseURL || defaultURL;
  return `${finalURL}/webhook/${token}`;
}

function ensureDestinationOrPrompt(userId, client) {
  const dest = STORE.destinations[userId];
  if (dest && dest.channel) return dest;
  // DM the admin requesting setup
  return client.conversations
    .open({ users: userId })
    .then(({ channel }) =>
      client.chat.postMessage({
        channel: channel.id,
        text: "Hypernative setup required",
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: "Set a destination thread for Hypernative alerts",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Choose a *channel* and (optional) existing *thread timestamp* where alerts should be posted.",
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Open setup" },
                action_id: "open_setup_modal",
                value: "open",
              },
            ],
          },
        ],
      })
    )
    .then(() => null)
    .catch((e) => {
      console.error("Failed to prompt for setup:", e);
      return null;
    });
}

function parseHypernativePayload(body) {
  // Body may be JSON with { id, data: stringified JSON, digitalSignature }
  const result = { raw: body, riskInsight: null };
  try {
    const dataStr = body.data || body.payload || body; // tolerate variants
    const parsed = typeof dataStr === "string" ? JSON.parse(dataStr) : dataStr;
    result.riskInsight = parsed.riskInsight || null;
  } catch (e) {
    console.error("Failed to parse Hypernative data:", e);
  }
  return result;
}

function summarizeBlocks(ri) {
  const name = ri?.name || "Transaction";
  const recommendation = ri?.riskTypeDescription || "Review required";
  const summary =
    ri?.interpretationSummary || ri?.details || "No summary provided";
  const chain = ri?.chain || "Unknown chain";
  const src =
    ri?.involvedAssets?.find((a) => /Origin/i.test(a.involvementType))?.alias ||
    "Unknown";
  const dst =
    ri?.involvedAssets?.find((a) => /Destination/i.test(a.involvementType))
      ?.alias || "Unknown";
  const timestamp = fmtUTC(ri?.timestamp);
  const severity = ri?.severity || "Info";

  // Optional balance change snippet
  const ctxItem = (ri?.context || []).find(
    (c) => c.title === "From Balance Changed"
  );
  let balanceLine = "—";
  if (ctxItem?.value) {
    try {
      const arr = JSON.parse(ctxItem.value);
      const first = Array.isArray(arr) ? arr[0] : arr;
      const item = Array.isArray(first) ? first[0] : first;
      const amount = item?.amount || "?";
      const symbol = item?.token_symbol || "";
      balanceLine = `Send ${amount} ${symbol}`;
    } catch {
      /* ignore */
    }
  }

  const header = `${name} initiated.`;

  // Normalize recommendation to "Accept it" or "Deny it"
  const normalizeRecommendation = (recommendation) => {
    const lowerRec = recommendation.toLowerCase();
    if (
      lowerRec.includes("deny") ||
      lowerRec.includes("reject") ||
      lowerRec.includes("block") ||
      lowerRec.includes("suspicious") ||
      lowerRec.includes("risky") ||
      lowerRec.includes("phishing") ||
      lowerRec.includes("scam")
    ) {
      return "Deny it";
    } else if (
      lowerRec.includes("accept") ||
      lowerRec.includes("approve") ||
      lowerRec.includes("allow") ||
      lowerRec.includes("safe") ||
      lowerRec.includes("legitimate")
    ) {
      return "Accept it";
    } else {
      // Default to deny for unknown recommendations (safer)
      return "Deny it";
    }
  };

  const normalizedRecommendation = normalizeRecommendation(recommendation);

  // Determine color based on recommendation (not severity)
  const getColorByRecommendation = (recommendation) => {
    return recommendation === "Accept it" ? "#36a64f" : "#ff0000"; // Green for accept, red for deny
  };

  // Format findings from context or use default
  let findings = "No critical findings";
  const findingsContext = (ri?.context || []).find(
    (c) => c.title === "Findings" || c.title === "Risk Factors"
  );
  if (findingsContext?.value) {
    findings = findingsContext.value;
  } else if (normalizedRecommendation === "Deny it") {
    // If we're recommending deny, look for risk indicators
    const riskKeywords = [
      "phishing",
      "scam",
      "suspicious",
      "risky",
      "malicious",
    ];
    const foundRisks = riskKeywords.filter(
      (keyword) =>
        summary.toLowerCase().includes(keyword) ||
        recommendation.toLowerCase().includes(keyword)
    );
    if (foundRisks.length > 0) {
      findings = foundRisks
        .map((risk) => risk.charAt(0).toUpperCase() + risk.slice(1))
        .join(", ");
    }
  }

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${header}*

*Recommendation:* ${normalizedRecommendation}

*Summary:*
${summary}

*Balance Changes:* ${balanceLine}

*Findings:* ${findings}

*Chain:* ${chain}

*Source:* ${src}

*Destination:* ${dst}

*Transaction initiated at:* ${timestamp}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Accept" },
            action_id: "accept_txn",
            value: ri?.txnHash || ri?.id || "unknown",
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Deny" },
            action_id: "deny_txn",
            value: ri?.txnHash || ri?.id || "unknown",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "View on chain" },
            url: ri?.txnHash
              ? `https://etherscan.io/tx/${ri.txnHash}`
              : undefined,
            action_id: "view_txn",
          },
        ],
      },
    ],
    // Add colored stripe based on recommendation
    color: getColorByRecommendation(normalizedRecommendation),
  };
}

// --- Interactivity: open setup modal
receiver.router.post(
  "/slack/actions",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    // Bolt will also handle this; but we include in case of stray requests
    res.status(200).end();
  }
);

app.action("open_setup_modal", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "setup_destination_modal",
      title: { type: "plain_text", text: "Hypernative Setup" },
      submit: { type: "plain_text", text: "Save" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "channel_b",
          label: { type: "plain_text", text: "Channel for alerts" },
          element: {
            type: "conversations_select",
            action_id: "channel",
            default_to_current_conversation: true,
            response_url_enabled: false,
          },
        },
      ],
    },
  });
});

app.view("setup_destination_modal", async ({ ack, body, view }) => {
  await ack();
  const userId = body.user.id;
  const channel = view.state.values.channel_b.channel.selected_conversation;

  updateStore((store) => {
    store.destinations[userId] = { channel };
  });

  const webhookURL = getUserWebhookURL(userId);

  try {
    await app.client.chat.postMessage({
      token: SLACK_BOT_TOKEN,
      channel: userId,
      text: `✅ Configuration complete!`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🎉 Your Hypernative bot is configured!",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Destination:* <#${channel}>\n*Your unique webhook URL:*\n\`${webhookURL}\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "📝 *Instructions:*\n• Use this URL in your Hypernative configuration\n• Only you can use this URL - it routes alerts to your chosen channel\n• Use `/hypernative-config` to view your settings anytime",
          },
        },
      ],
    });
  } catch (e) {
    console.error("Post setup ack failed:", e);
  }
});

// Slash command: /hypernative-setup
app.command("/hypernative-setup", async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.user_id,
    text: "Click to set up destination",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Let's set your destination for Hypernative alerts.",
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open setup" },
            action_id: "open_setup_modal",
          },
        ],
      },
    ],
  });
});

// Slash command: /hypernative-config - show user's current configuration
app.command("/hypernative-config", async ({ ack, body, client }) => {
  await ack();
  const userId = body.user_id;
  const dest = STORE.destinations[userId];

  if (!dest || !dest.channel) {
    await client.chat.postMessage({
      channel: userId,
      text: "❌ Not configured yet",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "You haven't configured your Hypernative alerts yet. Use `/hypernative-setup` to get started!",
          },
        },
      ],
    });
    return;
  }

  const webhookURL = getUserWebhookURL(userId);

  await client.chat.postMessage({
    channel: userId,
    text: "Your Hypernative configuration",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "📊 Your Hypernative Configuration" },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Destination Channel:* <#${dest.channel}>\n*Your Webhook URL:*\n\`${webhookURL}\``,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Update Configuration" },
            action_id: "open_setup_modal",
          },
        ],
      },
    ],
  });
});

// --- Message handling for conversational setup ---
app.message(
  /^(hi|hello|hey|setup|config|configure|help)/i,
  async ({ message, say, client }) => {
    const userId = message.user;
    console.log(
      `💬 Received greeting/setup message from user ${userId}: "${message.text}"`
    );
    const dest = STORE.destinations[userId];

    if (!dest || !dest.channel) {
      await say({
        text: "👋 Hi there! I can help you set up Hypernative alerts.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "👋 *Hi there!* I'm your Hypernative alerts bot.\n\nI can help you set up personalized webhook alerts that go directly to your chosen channel.",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "🚀 *Ready to get started?*\nI'll help you choose where you want your alerts to go, then give you a unique webhook URL.",
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "🔧 Set Up Alerts" },
                action_id: "open_setup_modal",
                style: "primary",
              },
            ],
          },
        ],
      });
    } else {
      const webhookURL = getUserWebhookURL(userId);
      await say({
        text: "👋 Hey! You're already configured.",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "👋 *Hey there!* You're already set up and ready to go!",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `📍 *Current setup:*\n• Alerts go to: <#${dest.channel}>\n• Your webhook: \`${webhookURL}\``,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "⚙️ Update Settings" },
                action_id: "open_setup_modal",
              },
            ],
          },
        ],
      });
    }
  }
);

// Handle requests for webhook URL
app.message(/(webhook|url|link)/i, async ({ message, say }) => {
  const userId = message.user;
  console.log(`🔗 User ${userId} requested webhook URL: "${message.text}"`);
  const dest = STORE.destinations[userId];

  if (!dest || !dest.channel) {
    await say({
      text: "❌ You need to set up your alerts first!",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "❌ *Oops!* You haven't configured your alerts yet.\n\nLet me help you get set up first, then I'll give you your webhook URL.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "🔧 Set Up Now" },
              action_id: "open_setup_modal",
              style: "primary",
            },
          ],
        },
      ],
    });
  } else {
    const webhookURL = getUserWebhookURL(userId);
    await say({
      text: `Here's your webhook URL: ${webhookURL}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔗 *Here's your personal webhook URL:*\n\`${webhookURL}\`\n\n📋 *How to use it:*\n• Copy this URL into your Hypernative configuration\n• It will send alerts to <#${dest.channel}>\n• Only you can use this URL`,
          },
        },
      ],
    });
  }
});

// Handle general questions and help
app.message(/(how|what|where|status)/i, async ({ message, say }) => {
  const userId = message.user;
  const dest = STORE.destinations[userId];

  await say({
    text: "Here's how I can help you:",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🤖 *I'm your Hypernative alerts assistant!*\n\nHere's what I can do for you:",
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            dest && dest.channel
              ? '✅ *You\'re already configured!*\n• Get your webhook URL: just say "webhook" or "url"\n• Update settings: say "setup" or "configure"\n• View status: say "status" or "config"'
              : '⚙️ *Get started:*\n• Say "setup" or "configure" to begin\n• I\'ll help you choose where alerts should go\n• Then I\'ll give you a unique webhook URL',
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "💬 *You can also use slash commands:*\n• `/hypernative-setup` - Configure alerts\n• `/hypernative-config` - View current settings",
        },
      },
    ],
  });
});

// --- App Home (when users visit the bot's profile/home tab) ---
app.event("app_home_opened", async ({ event, client }) => {
  console.log(
    "🏠 App home opened event received:",
    JSON.stringify(event, null, 2)
  );
  const userId = event.user;

  // Validate userId before proceeding
  if (!userId) {
    console.error("❌ Invalid user_id in app_home_opened event:", event);
    return;
  }

  // Validate user_id format (should start with 'U')
  if (!userId.startsWith("U")) {
    console.error(
      `❌ Invalid user_id format: ${userId} (should start with 'U')`
    );
    return;
  }

  console.log(`🏠 Processing app home for user: ${userId}`);

  const dest = STORE.destinations[userId];

  try {
    const homeView = {
      type: "home",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🤖 Hypernative Alerts Bot",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              dest && dest.channel
                ? `✅ *You're all set up!*\n\nYour alerts will be posted to <#${
                    dest.channel
                  }>.\n\nYour webhook URL:\n\`${getUserWebhookURL(userId)}\``
                : "👋 *Welcome!* I help you receive Hypernative alerts in Slack.\n\nGet started by configuring where you want your alerts to go.",
          },
        },
        {
          type: "actions",
          elements:
            dest && dest.channel
              ? [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "⚙️ Update Configuration",
                    },
                    action_id: "open_setup_modal",
                  },
                ]
              : [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "🚀 Get Started" },
                    action_id: "open_setup_modal",
                    style: "primary",
                  },
                ],
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: '💬 *You can also talk to me!*\nJust send me a DM with:\n• "hi" or "hello" to get started\n• "webhook" or "url" to get your webhook URL\n• "help" to see what I can do',
          },
        },
      ],
    };

    await client.views.publish({
      user_id: userId,
      view: homeView,
    });
    console.log(`✅ Successfully published home view for user: ${userId}`);
  } catch (error) {
    console.error(`❌ Error publishing home view for user ${userId}:`, error);
    if (error.data && error.data.error === "invalid_arguments") {
      console.error(
        "❌ Invalid arguments - user_id might be malformed:",
        userId
      );
    }
  }
});

// --- Accept / Deny actions
app.action("accept_txn", async ({ ack, body, client, action }) => {
  await ack();
  const value = action.value;
  const channel = body.channel?.id;
  const ts = body.message?.ts;

  try {
    // Get the original message
    const originalMessage = body.message;

    // Update the message with acceptance status - replace the actions block
    const updatedAttachments = originalMessage.attachments.map(
      (attachment) => ({
        ...attachment,
        blocks: attachment.blocks.map((block) => {
          // Replace the actions block with the decision status
          if (block.type === "actions") {
            return {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Accepted by <@${body.user.id}>*`,
              },
            };
          }
          return block;
        }),
      })
    );

    await client.chat.update({
      channel,
      ts,
      text: originalMessage.text,
      attachments: updatedAttachments,
    });

    console.log(`✅ Transaction accepted by user ${body.user.id} for ${value}`);
  } catch (error) {
    console.error("Error updating message after accept:", error);
    // Fallback to posting a reply if update fails
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `✅ Accepted by <@${body.user.id}> for ${value}`,
    });
  }
});

app.action("deny_txn", async ({ ack, body, client, action }) => {
  await ack();
  const value = action.value;
  const channel = body.channel?.id;
  const ts = body.message?.ts;

  try {
    // Get the original message
    const originalMessage = body.message;

    // Update the message with denial status - replace the actions block
    const updatedAttachments = originalMessage.attachments.map(
      (attachment) => ({
        ...attachment,
        blocks: attachment.blocks.map((block) => {
          // Replace the actions block with the decision status
          if (block.type === "actions") {
            return {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🚫 *Denied by <@${body.user.id}>*`,
              },
            };
          }
          return block;
        }),
      })
    );

    await client.chat.update({
      channel,
      ts,
      text: originalMessage.text,
      attachments: updatedAttachments,
    });

    console.log(`🚫 Transaction denied by user ${body.user.id} for ${value}`);
  } catch (error) {
    console.error("Error updating message after deny:", error);
    // Fallback to posting a reply if update fails
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `🚫 Denied by <@${body.user.id}> for ${value}`,
    });
  }
});

// --- External webhook to receive Hypernative POSTs ---
receiver.router.post(
  "/hypernative/webhook",
  express.json({ limit: "2mb" }),
  async (req, res) => {
    try {
      const auth = req.headers["authorization"] || "";
      if (
        !auth.startsWith("Bearer ") ||
        auth.slice(7) !== EXTERNAL_WEBHOOK_TOKEN
      ) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const { riskInsight } = parseHypernativePayload(req.body);
      if (!riskInsight)
        return res.status(400).json({ ok: false, error: "bad_payload" });

      // Determine who to notify; here we use ADMIN_USER_ID, but you can map from payload if needed
      let dest = STORE.destinations[ADMIN_USER_ID];
      if (!dest) {
        await ensureDestinationOrPrompt(ADMIN_USER_ID, app.client);
        return res.status(202).json({
          ok: true,
          message: "prompted for setup; try again after destination is set",
        });
      }

      const alertData = summarizeBlocks(riskInsight);
      const post = await app.client.chat.postMessage({
        token: SLACK_BOT_TOKEN,
        channel: dest.channel,
        text: "Hypernative transaction alert",
        attachments: [
          {
            color: alertData.color,
            blocks: alertData.blocks,
          },
        ],
      });

      return res.json({ ok: true, channel: post.channel, ts: post.ts });
    } catch (e) {
      console.error("webhook error", e);
      // Save data even if webhook fails
      try {
        saveStore(STORE);
      } catch (saveError) {
        console.error("Failed to save after webhook error:", saveError);
      }
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

// User-specific webhook endpoint
receiver.router.post(
  "/webhook/:token",
  express.json({ limit: "2mb" }),
  async (req, res) => {
    try {
      const { token } = req.params;
      console.log(`🎯 Received webhook request for token: ${token}`);

      // Ensure backward compatibility with existing storage
      if (!STORE.tokenToUser) {
        console.log(`❌ STORE.tokenToUser is missing`);
        return res.status(404).json({ ok: false, error: "token_not_found" });
      }

      console.log(`🔍 Looking for token: ${token}`);
      console.log(
        `🔍 Available tokens: ${Object.keys(STORE.tokenToUser).join(", ")}`
      );

      const userId = STORE.tokenToUser[token];
      if (!userId) {
        console.log(`❌ Token not found: ${token}`);
        console.log(`❌ Current tokenToUser mapping:`, STORE.tokenToUser);
        return res.status(404).json({ ok: false, error: "token_not_found" });
      }

      console.log(`✅ Token mapped to user: ${userId}`);

      const { riskInsight } = parseHypernativePayload(req.body);
      if (!riskInsight)
        return res.status(400).json({ ok: false, error: "bad_payload" });

      let dest = STORE.destinations[userId];
      if (!dest || !dest.channel) {
        console.log(`❌ User ${userId} not configured for alerts`);
        return res.status(404).json({
          ok: false,
          error: "user_not_configured",
          message: "User needs to run /hypernative-setup first",
        });
      }

      console.log(
        `📤 Posting alert to channel ${dest.channel} for user ${userId}`
      );

      const alertData = summarizeBlocks(riskInsight);

      // Try to post the message, and if channel_not_found, attempt to join first
      let post;
      try {
        post = await app.client.chat.postMessage({
          token: SLACK_BOT_TOKEN,
          channel: dest.channel,
          text: "Hypernative transaction alert",
          attachments: [
            {
              color: alertData.color,
              blocks: alertData.blocks,
            },
          ],
        });
      } catch (error) {
        if (error.data && error.data.error === "channel_not_found") {
          console.log(
            `🔄 Channel not found, attempting to join channel ${dest.channel}`
          );
          try {
            // Try to join the channel
            await app.client.conversations.join({
              token: SLACK_BOT_TOKEN,
              channel: dest.channel,
            });
            console.log(`✅ Successfully joined channel ${dest.channel}`);

            // Retry posting the message
            post = await app.client.chat.postMessage({
              token: SLACK_BOT_TOKEN,
              channel: dest.channel,
              text: "Hypernative transaction alert",
              attachments: [
                {
                  color: alertData.color,
                  blocks: alertData.blocks,
                },
              ],
            });
          } catch (joinError) {
            console.error(
              `❌ Failed to join channel ${dest.channel}:`,
              joinError
            );
            throw error; // Re-throw the original error
          }
        } else {
          throw error; // Re-throw if it's not a channel_not_found error
        }
      }

      return res.json({
        ok: true,
        channel: post.channel,
        ts: post.ts,
        user: userId,
      });
    } catch (e) {
      console.error("user webhook error", e);
      // Save data even if webhook fails
      try {
        saveStore(STORE);
      } catch (saveError) {
        console.error("Failed to save after user webhook error:", saveError);
      }
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  }
);

// OAuth installation endpoint
receiver.router.get("/slack/install", (req, res) => {
  const clientId = process.env.SLACK_CLIENT_ID;
  const scopes =
    "app_mentions:read,channels:read,channels:join,chat:write,chat:write.public,commands,groups:read,im:history,im:read,im:write,mpim:write,users:read";

  const installUrl = `https://slack.com/oauth/v2/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(
    process.env.BASE_URL || "http://localhost:3000"
  )}/slack/oauth_redirect`;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Install Hypernative Slack Bot</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
            .install-btn { background: #4A154B; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 20px 0; }
            .install-btn:hover { background: #611f69; }
            .feature { margin: 10px 0; }
            .feature::before { content: "✅ "; }
        </style>
    </head>
    <body>
        <h1>🤖 Hypernative Slack Bot</h1>
        <p>Get personalized Hypernative alerts delivered directly to your Slack channels.</p>
        
        <h3>Features:</h3>
        <div class="feature">Personal webhook URLs for each user</div>
        <div class="feature">Configurable alert destinations</div>
        <div class="feature">Interactive setup via DM or slash commands</div>
        <div class="feature">Accept/Deny transaction buttons</div>
        
        <a href="${installUrl}" class="install-btn">Add to Slack</a>
        
        <h3>After Installation:</h3>
        <p>1. Use <code>/hypernative-setup</code> to configure your alerts</p>
        <p>2. Or DM the bot with "hi" to get started</p>
        <p>3. Get your unique webhook URL and add it to Hypernative</p>
    </body>
    </html>
  `);
});

// OAuth redirect handler
receiver.router.get("/slack/oauth_redirect", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    console.log(`❌ OAuth error: ${error}`);
    return res.send(`
      <h1>❌ Installation Failed</h1>
      <p>Error: ${error}</p>
      <a href="/slack/install">Try Again</a>
    `);
  }

  if (!code) {
    return res.send(`
      <h1>❌ Installation Failed</h1>
      <p>No authorization code received</p>
      <a href="/slack/install">Try Again</a>
    `);
  }

  try {
    // Exchange code for access token
    const result = await app.client.oauth.v2.access({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code: code,
      redirect_uri: `${
        process.env.BASE_URL || "http://localhost:3000"
      }/slack/oauth_redirect`,
    });

    console.log(
      `✅ OAuth successful for team: ${result.team.name} (${result.team.id})`
    );

    // Store installation data
    const installation = {
      team: result.team,
      enterprise: result.enterprise,
      bot: result.bot_user_id,
      token: result.access_token,
      scopes: result.scope,
      userId: result.authed_user?.id,
      installedAt: new Date().toISOString(),
    };

    // Save to installations store (you might want to use a database for production)
    updateStore((store) => {
      if (!store.installations) store.installations = {};
      store.installations[result.team.id] = installation;
    });

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
          <title>Installation Successful</title>
          <style>
              body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
              .success { color: #28a745; font-size: 48px; }
          </style>
      </head>
      <body>
          <div class="success">✅</div>
          <h1>Installation Successful!</h1>
          <p>Hypernative Slack Bot has been installed to <strong>${result.team.name}</strong></p>
          
          <h3>Next Steps:</h3>
          <p>1. Go to your Slack workspace</p>
          <p>2. Use <code>/hypernative-setup</code> to configure alerts</p>
          <p>3. Or DM the bot with "hi" to get started</p>
          
          <p><a href="slack://open">Open Slack</a></p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error(`❌ OAuth exchange failed:`, error);
    res.send(`
      <h1>❌ Installation Failed</h1>
      <p>Failed to complete installation: ${error.message}</p>
      <a href="/slack/install">Try Again</a>
    `);
  }
});

// Health check with storage status
receiver.router.get("/healthz", (req, res) => {
  const storageStats = {
    destinations: Object.keys(STORE.destinations).length,
    userTokens: Object.keys(STORE.userTokens).length,
    tokenMappings: Object.keys(STORE.tokenToUser).length,
    installations: Object.keys(STORE.installations).length,
    lastSave: lastSaveTime,
    storagePath: PERSIST_PATH,
  };

  res.json({
    status: "ok",
    storage: storageStats,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

(async () => {
  console.log(`🚀 Starting Hypernative Slack Bot...`);
  console.log(`📝 Configuration:`);
  console.log(`   Port: ${PORT}`);
  console.log(
    `   Base URL: ${process.env.BASE_URL || "http://localhost:3000"}`
  );
  console.log(`   Admin User: ${ADMIN_USER_ID}`);
  console.log(`   Storage Path: ${PERSIST_PATH}`);

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

/* -----------------------
package.json
----------------------- */
// {
//   "name": "hypernative-slack-bot",
//   "version": "1.0.0",
//   "main": "app.js",
//   "type": "commonjs",
//   "scripts": {
//     "start": "node app.js",
//     "dev": "nodemon app.js"
//   },
//   "dependencies": {
//     "@slack/bolt": "^3.18.0",
//     "dotenv": "^16.4.5",
//     "express": "^4.19.2"
//   },
//   "devDependencies": {
//     "nodemon": "^3.0.2"
//   }
// }

/* -----------------------
.env.example
----------------------- */
// SLACK_SIGNING_SECRET=...
// SLACK_BOT_TOKEN=xoxb-...
// ADMIN_USER_ID=U012ABCDEF
// EXTERNAL_WEBHOOK_TOKEN=supersecrettoken
// PORT=3000
// PERSIST_PATH=./storage.json

/* -----------------------
Slack App Configuration (minimal)
-----------------------
1) Create an app in https://api.slack.com/apps → Basic Information.
2) Add features & functionality:
   - OAuth & Permissions → Scopes (Bot Token):
     channels:read, channels:join, chat:write, chat:write.public, groups:read, im:history, im:write, mpim:write, commands, users:read
   - App Home → *On* (required for home tab functionality)
   - Interactivity & Shortcuts → *On*, Request URL: https://<your-domain>/slack/events
   - Slash Commands (optional): /hypernative-setup → https://<your-domain>/slack/events
   - Event Subscriptions: *On*, Request URL: https://<your-domain>/slack/events (no events strictly required here).
3) Install to Workspace and copy the Bot Token and Signing Secret.
4) Expose your local server (e.g., `npx ngrok http 3000`) or host it. Your external service will POST to:
   POST https://<your-domain>/hypernative/webhook
   Authorization: Bearer EXTERNAL_WEBHOOK_TOKEN

Testing the webhook locally:
  curl -X POST \
    -H "Authorization: Bearer supersecrettoken" \
    -H "Content-Type: application/json" \
    --data '{
      "id": "fbeae6d8-51e9-49a0-b5d9-ca04d6f173ea",
      "data": "<PASTE THE JSON STRING FROM YOUR EXAMPLE HERE>"
    }' \
    http://localhost:3000/hypernative/webhook

Notes:
- First run will DM the ADMIN_USER_ID to choose a channel & optional existing thread. After saving, the webhook will post there (or into the provided thread).
- Buttons post a threaded confirmation (✅/🚫). You can extend those handlers to call back to Hypernative or a policy engine.
- For multi-tenant mapping, replace ADMIN_USER_ID with a lookup based on the payload (e.g., watchlist or API key → Slack user).
*/
