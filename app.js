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

// GitHub Gist storage configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Personal access token for GitHub API
const GIST_ID = process.env.GIST_ID; // ID of the Gist to use for storage
const USE_GIST_STORAGE = process.env.USE_GIST_STORAGE === "true"; // Enable Gist storage

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

// ---- GitHub Gist Storage Functions ----
async function loadFromGist() {
  if (!GITHUB_TOKEN || !GIST_ID) {
    throw new Error("GitHub token or Gist ID not configured");
  }

  try {
    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Hypernative-Slack-Bot",
      },
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    const gist = await response.json();
    const content = gist.files["storage.json"]?.content;

    if (!content) {
      throw new Error("No storage.json file found in Gist");
    }

    const parsed = JSON.parse(content);
    const store = {
      destinations: parsed.destinations || {},
      userTokens: parsed.userTokens || {},
      tokenToUser: parsed.tokenToUser || {},
      installations: parsed.installations || {},
    };

    console.log(
      `📂 ✅ Loaded storage from Gist: ${
        Object.keys(store.userTokens).length
      } user tokens, ${Object.keys(store.destinations).length} destinations`
    );
    return store;
  } catch (error) {
    console.log(`📂 ❌ Failed to load from Gist: ${error.message}`);
    throw error;
  }
}

async function saveToGist(store) {
  if (!GITHUB_TOKEN || !GIST_ID) {
    throw new Error("GitHub token or Gist ID not configured");
  }

  try {
    const content = JSON.stringify(store, null, 2);

    const response = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Hypernative-Slack-Bot",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: {
          "storage.json": {
            content: content,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`
      );
    }

    console.log(`📂 ✅ Saved storage to Gist successfully`);
  } catch (error) {
    console.log(`📂 ❌ Failed to save to Gist: ${error.message}`);
    throw error;
  }
}

// ---- Tiny persistence (JSON file or Gist) ----
async function loadStore() {
  if (USE_GIST_STORAGE) {
    console.log(`📂 Loading storage from GitHub Gist: ${GIST_ID}`);
    try {
      return await loadFromGist();
    } catch (error) {
      console.log(`📂 ❌ Gist storage failed, falling back to local file`);
    }
  }

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
async function saveStore(store) {
  if (USE_GIST_STORAGE) {
    try {
      await saveToGist(store);
      return;
    } catch (error) {
      console.error(
        `❌ Gist storage failed, falling back to local file:`,
        error
      );
    }
  }

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
let STORE = null;

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

// Initialize storage on startup
async function initializeStorage() {
  try {
    STORE = await loadStore();
    STORE = validateStorage(STORE);
    console.log(`📂 Storage initialized successfully`);
  } catch (error) {
    console.error(`❌ Failed to initialize storage:`, error);
    // Create empty store as fallback
    STORE = {
      destinations: {},
      userTokens: {},
      tokenToUser: {},
      installations: {},
    };
  }
}

// Safe storage update function that automatically saves
async function updateStore(updateFn) {
  try {
    updateFn(STORE);
    await saveStore(STORE);
  } catch (error) {
    console.error(`❌ Failed to update storage:`, error);
    throw error;
  }
}

// Helper function to translate global user IDs to local IDs
async function translateUserId(client, userId) {
  if (!userId || !userId.startsWith("U") || userId.length <= 11) {
    return userId; // Not a global ID or invalid format
  }

  try {
    console.log(`🌍 Attempting to translate global user ID: ${userId}`);
    const userInfo = await client.users.info({ user: userId });
    if (userInfo.user && userInfo.user.id !== userId) {
      console.log(
        `🔄 Translated global ID ${userId} to local ID ${userInfo.user.id}`
      );
      return userInfo.user.id;
    }
    return userId; // No translation needed
  } catch (userError) {
    console.log(
      `⚠️ Could not translate user ID ${userId}, using as-is:`,
      userError.message
    );
    return userId; // Use original ID if translation fails
  }
}

// Helper function to validate if a channel is accessible
async function validateChannelAccess(client, channelId, workspaceToken = null) {
  try {
    const token = workspaceToken || SLACK_BOT_TOKEN;
    const channelInfo = await client.conversations.info({
      token: token,
      channel: channelId,
    });
    return { accessible: true, channel: channelInfo.channel };
  } catch (error) {
    if (error.data && error.data.error === "channel_not_found") {
      return { accessible: false, error: "channel_not_found" };
    }
    return { accessible: false, error: error.message };
  }
}

// Helper function to get workspace-specific token
function getWorkspaceToken(teamId) {
  const workspaceData = workspaceTokens.get(teamId);
  if (workspaceData && workspaceData.token) {
    console.log(`🔑 Using workspace-specific token for team: ${teamId}`);
    return workspaceData.token;
  }

  // Fallback to default token
  console.log(
    `⚠️ No workspace-specific token found for team: ${teamId}, using default token`
  );
  return SLACK_BOT_TOKEN;
}

// Helper function to create workspace-specific client
function createWorkspaceClient(teamId) {
  const token = getWorkspaceToken(teamId);
  return new app.client.constructor({ token });
}

// Periodic auto-save to prevent data loss
let lastSaveTime = Date.now();
const AUTO_SAVE_INTERVAL = 30000; // 30 seconds

setInterval(async () => {
  try {
    const now = Date.now();
    if (now - lastSaveTime >= AUTO_SAVE_INTERVAL) {
      await saveStore(STORE);
      lastSaveTime = now;
      console.log(`🔄 Auto-save completed at ${new Date().toISOString()}`);
    }
  } catch (error) {
    console.error(`❌ Auto-save failed:`, error);
  }
}, AUTO_SAVE_INTERVAL);

// Graceful shutdown handler
process.on("SIGINT", async () => {
  console.log("\n🛑 Received SIGINT, saving data before exit...");
  try {
    await saveStore(STORE);
    console.log("✅ Data saved successfully");
  } catch (error) {
    console.error("❌ Failed to save data on exit:", error);
  }
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Received SIGTERM, saving data before exit...");
  try {
    await saveStore(STORE);
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
    await saveStore(STORE);
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
    await saveStore(STORE);
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

async function getUserToken(userId) {
  // Ensure backward compatibility with existing storage
  if (!STORE.userTokens) STORE.userTokens = {};
  if (!STORE.tokenToUser) STORE.tokenToUser = {};

  if (STORE.userTokens[userId]) {
    return STORE.userTokens[userId];
  }

  // Generate new token for user
  const token = randomUUID();
  await updateStore((store) => {
    store.userTokens[userId] = token;
    store.tokenToUser[token] = userId;
  });

  return token;
}

async function getUserWebhookURL(userId, baseURL) {
  const token = await getUserToken(userId);
  // Default to localhost for development, but allow override
  const defaultURL = process.env.BASE_URL || "http://localhost:3000";
  const finalURL = baseURL || defaultURL;
  return `${finalURL}/webhook/${token}`;
}

async function ensureDestinationOrPrompt(userId, client) {
  const dest = STORE.destinations[userId];
  if (dest && dest.channel) return dest;

  // Check if this is a global user from a different workspace
  try {
    const userInfo = await client.users.info({ user: userId });
    const authTest = await client.auth.test();

    if (userInfo.user.team_id !== authTest.team_id) {
      console.log(
        `🌍 Global user ${userId} from different workspace (${userInfo.user.team_id})`
      );

      // Try to use workspace-specific token to open DM
      const workspaceToken = getWorkspaceToken(userInfo.user.team_id);
      if (workspaceToken !== SLACK_BOT_TOKEN) {
        console.log(`🔑 Using workspace-specific token for DM`);
        const workspaceClient = new app.client.constructor({
          token: workspaceToken,
        });

        try {
          const { channel } = await workspaceClient.conversations.open({
            users: userId,
          });
          await workspaceClient.chat.postMessage({
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
          });
          return null;
        } catch (dmError) {
          console.log(
            `❌ Failed to DM global user with workspace token:`,
            dmError.message
          );
        }
      }

      console.log(
        `💡 Global users should use slash commands instead: /hypernative-setup`
      );
      return null;
    }
  } catch (error) {
    console.log(
      `⚠️ Could not verify user workspace for ${userId}:`,
      error.message
    );

    // If user_not_found, it's likely a global user from another workspace
    if (error.data && error.data.error === "user_not_found") {
      console.log(`🌍 User ${userId} not found - treating as global user`);
      console.log(
        `💡 Global users should use slash commands instead: /hypernative-setup`
      );
      return null;
    }

    // For any other error, also treat as global user to avoid DM failures
    console.log(
      `🌍 Treating user ${userId} as global user due to access error`
    );
    console.log(
      `💡 Global users should use slash commands instead: /hypernative-setup`
    );
    return null;
  }

  // DM the admin requesting setup
  try {
    const { channel } = await client.conversations.open({ users: userId });
    await client.chat.postMessage({
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
    });
    return null;
  } catch (e) {
    console.error("Failed to prompt for setup:", e);
    if (e.data && e.data.error === "channel_not_found") {
      console.log(
        `💡 User ${userId} cannot receive DMs. Try using slash command: /hypernative-setup`
      );
    }
    return null;
  }
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

app.view("setup_destination_modal", async ({ ack, body, view, client }) => {
  await ack();
  const originalUserId = body.user.id;
  const channel = view.state.values.channel_b.channel.selected_conversation;

  // Translate global user ID to local ID if needed
  const userId = await translateUserId(client, originalUserId);

  // Get workspace token for channel validation
  let userWorkspaceId = null;
  try {
    const userInfo = await client.users.info({ user: originalUserId });
    userWorkspaceId = userInfo.user.team_id;
  } catch (userError) {
    console.log(`⚠️ Could not get user workspace info:`, userError.message);
  }

  // Validate that the selected channel is accessible
  const workspaceToken = getWorkspaceToken(userWorkspaceId);
  const channelValidation = await validateChannelAccess(
    client,
    channel,
    workspaceToken
  );
  if (!channelValidation.accessible) {
    console.error(
      `❌ Selected channel ${channel} is not accessible:`,
      channelValidation.error
    );

    // Use workspace-specific token for error message
    const errorWorkspaceClient = new app.client.constructor({
      token: workspaceToken,
    });
    await errorWorkspaceClient.chat.postMessage({
      channel: originalUserId,
      text: "❌ Channel setup failed",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `❌ *Channel Setup Failed*\n\nThe channel you selected (<#${channel}>) is not accessible. This might be because:\n• The channel is from a different workspace\n• The bot doesn't have permission to access the channel\n• The channel no longer exists\n\nPlease try selecting a different channel.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Try Again" },
              action_id: "open_setup_modal",
            },
          ],
        },
      ],
    });
    return;
  }

  await updateStore((store) => {
    store.destinations[userId] = { channel };
  });

  const webhookURL = await getUserWebhookURL(userId);

  try {
    // Use workspace-specific token for success message
    const successWorkspaceClient = new app.client.constructor({
      token: workspaceToken,
    });
    await successWorkspaceClient.chat.postMessage({
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

  // Get workspace token for slash command
  let userWorkspaceId = null;
  try {
    const userInfo = await client.users.info({ user: body.user_id });
    userWorkspaceId = userInfo.user.team_id;
  } catch (userError) {
    console.log(`⚠️ Could not get user workspace info:`, userError.message);
  }

  const workspaceToken = getWorkspaceToken(userWorkspaceId);
  const workspaceClient = new app.client.constructor({ token: workspaceToken });

  await workspaceClient.chat.postMessage({
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

  // Get workspace token for slash command
  let userWorkspaceId = null;
  try {
    const userInfo = await client.users.info({ user: userId });
    userWorkspaceId = userInfo.user.team_id;
  } catch (userError) {
    console.log(`⚠️ Could not get user workspace info:`, userError.message);
  }

  const workspaceToken = getWorkspaceToken(userWorkspaceId);
  const workspaceClient = new app.client.constructor({ token: workspaceToken });

  if (!dest || !dest.channel) {
    await workspaceClient.chat.postMessage({
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

  const webhookURL = await getUserWebhookURL(userId);

  await workspaceClient.chat.postMessage({
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

    // Check if this is a global user from a different workspace
    let isGlobalUser = false;
    try {
      const userInfo = await client.users.info({ user: userId });
      const authTest = await client.auth.test();
      isGlobalUser = userInfo.user.team_id !== authTest.team_id;

      if (isGlobalUser) {
        console.log(
          `🌍 Global user ${userId} from different workspace detected`
        );
      }
    } catch (error) {
      console.log(
        `⚠️ Could not verify user workspace for ${userId}:`,
        error.message
      );

      // If user_not_found, it's likely a global user from another workspace
      if (error.data && error.data.error === "user_not_found") {
        console.log(`🌍 User ${userId} not found - treating as global user`);
        isGlobalUser = true;
      }
    }

    const dest = STORE.destinations[userId];

    if (!dest || !dest.channel) {
      if (isGlobalUser) {
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
                text: "🌍 *You're from a different workspace*\nSince you're from another workspace, please use the slash command to set up your alerts:",
              },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "💬 *Use this command:*\n`/hypernative-setup`\n\nThis will open the setup modal where you can choose your destination channel and get your webhook URL.",
              },
            },
          ],
        });
      } else {
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
      }
    } else {
      const webhookURL = await getUserWebhookURL(userId);
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
    const webhookURL = await getUserWebhookURL(userId);
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

// Track home view failures to disable if consistently failing
let homeViewFailures = 0;
const MAX_HOME_VIEW_FAILURES = 5;

// Track which workspaces the bot is installed in and their tokens
let workspaceTokens = new Map(); // { teamId: { token, team, bot, user, scopes } }

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

  // Check if home view is disabled due to repeated failures
  if (homeViewFailures >= MAX_HOME_VIEW_FAILURES) {
    console.log(
      "🚫 Home view disabled due to repeated failures. Use DM or slash commands instead."
    );
    return;
  }

  console.log(`🏠 Processing app home for user: ${userId}`);

  // Get bot and user workspace information for debugging
  let botWorkspaceInfo = null;
  let userWorkspaceInfo = null;
  let userWorkspaceId = null;

  try {
    const authTest = await client.auth.test();
    botWorkspaceInfo = {
      team_id: authTest.team_id,
      team_name: authTest.team,
      user_id: authTest.user_id,
      bot_id: authTest.bot_id,
    };
    console.log(`🤖 Bot workspace info:`, botWorkspaceInfo);

    // Track this workspace as installed
    console.log(
      `📋 Installed workspaces with tokens:`,
      Array.from(workspaceTokens.keys())
    );
  } catch (authError) {
    console.error(`❌ Could not get bot workspace info:`, authError);
  }

  // Try to get user info with workspace-specific token first
  let userInfo = null;
  let workspaceClient = client; // Default to original client

  // Check if we have workspace tokens and try to find the right one
  if (workspaceTokens.size === 0) {
    console.log(
      `⚠️ No workspace tokens available - bot may not be installed in other workspaces`
    );
  }

  for (const [teamId, workspaceData] of workspaceTokens.entries()) {
    try {
      const testClient = new app.client.constructor({
        token: workspaceData.token,
      });
      const testUserInfo = await testClient.users.info({ user: userId });
      if (testUserInfo.user) {
        userInfo = testUserInfo;
        userWorkspaceId = teamId;
        workspaceClient = testClient;
        console.log(
          `🔑 Found user ${userId} in workspace ${teamId}, using workspace-specific client`
        );
        break;
      }
    } catch (error) {
      // Continue trying other workspaces
      continue;
    }
  }

  // If not found in any workspace, try with default client
  if (!userInfo) {
    try {
      userInfo = await client.users.info({ user: userId });
      userWorkspaceId = userInfo.user.team_id;
      console.log(`👤 User info retrieved with default client:`, userInfo.user);
    } catch (error) {
      console.error(`❌ Cannot access user ${userId} with any client:`, error);
      if (error.data && error.data.error === "user_not_found") {
        console.log(
          `🌍 User ${userId} not found - likely from different workspace`
        );
        if (workspaceTokens.size === 0) {
          console.log(
            `💡 Bot is not installed in any other workspaces. User needs to install the bot in their workspace first.`
          );
          console.log(
            `💡 Installation URL: ${
              process.env.BASE_URL || "http://localhost:3000"
            }/slack/install`
          );
        } else {
          console.log(
            `💡 Global users should use DM or slash commands instead of App Home`
          );
        }
        return;
      }
      console.log("🚫 Skipping home view - user not accessible");
      return;
    }
  }

  // Translate global user ID to local ID if needed
  const localUserId = await translateUserId(workspaceClient, userId);

  const dest = STORE.destinations[localUserId];

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
                  }>.\n\nYour webhook URL:\n\`${await getUserWebhookURL(
                    userId
                  )}\``
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

    // Set user workspace info for comparison
    userWorkspaceInfo = {
      team_id: userInfo.user.team_id,
      user_id: userInfo.user.id,
      name: userInfo.user.name,
      real_name: userInfo.user.real_name,
    };
    console.log(`👤 User workspace info:`, userWorkspaceInfo);

    // Compare workspaces
    if (botWorkspaceInfo && userWorkspaceInfo) {
      const sameWorkspace =
        botWorkspaceInfo.team_id === userWorkspaceInfo.team_id;
      console.log(`🏢 Same workspace: ${sameWorkspace}`);
      console.log(
        `🏢 Bot workspace: ${botWorkspaceInfo.team_name} (${botWorkspaceInfo.team_id})`
      );
      console.log(`🏢 User workspace: ${userWorkspaceInfo.team_id}`);

      if (!sameWorkspace) {
        console.log(
          `🌍 User is from different workspace - using workspace-specific token`
        );
      }
    }

    // Try to publish the home view using the workspace client we found
    console.log(`🔍 Attempting to publish home view for user: ${localUserId}`);
    console.log(`🔍 Home view structure:`, JSON.stringify(homeView, null, 2));

    console.log(
      `🔑 Using workspace client for App Home: ${
        workspaceClient !== client ? "workspace-specific" : "default"
      }`
    );

    const result = await workspaceClient.views.publish({
      user_id: localUserId,
      view: homeView,
    });
    console.log(
      `✅ Successfully published home view for user: ${localUserId} (original: ${userId}) using workspace token`,
      result
    );

    // Reset failure counter on success
    homeViewFailures = 0;
  } catch (error) {
    console.error(`❌ Error publishing home view for user ${userId}:`, error);

    // Increment failure counter
    homeViewFailures++;
    console.log(
      `❌ Home view failure count: ${homeViewFailures}/${MAX_HOME_VIEW_FAILURES}`
    );

    if (error.data && error.data.error === "invalid_arguments") {
      console.error("❌ Invalid arguments error details:", error.data);
      console.error("❌ Response metadata:", error.data.response_metadata);

      // Try alternative approach - check if it's a scope issue
      console.log("🔍 Checking bot permissions...");
      try {
        const authTest = await client.auth.test();
        console.log("🔍 Bot auth info:", authTest);

        // Check if App Home is enabled by trying to get app info
        try {
          const appInfo = await client.apps.info();
          console.log("🔍 App info:", appInfo);
        } catch (appInfoError) {
          console.log(
            "⚠️ Could not get app info (this might be normal):",
            appInfoError.message
          );
        }

        // Check bot's capabilities and features
        try {
          const teamInfo = await client.team.info();
          console.log("🔍 Team info:", {
            team_id: teamInfo.team.id,
            team_name: teamInfo.team.name,
            domain: teamInfo.team.domain,
            plan: teamInfo.team.plan || "unknown",
          });
        } catch (teamError) {
          console.log("⚠️ Could not get team info:", teamError.message);
        }
      } catch (authError) {
        console.error("❌ Auth test failed:", authError);
      }
    }

    // Don't crash - just log the error and continue
    console.log("🔄 Bot continuing despite home view error...");

    // If we've hit the failure limit, disable home view
    if (homeViewFailures >= MAX_HOME_VIEW_FAILURES) {
      console.log(
        "🚫 Home view disabled due to repeated failures. Users should use DM or slash commands instead."
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
        await saveStore(STORE);
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

      // Get user's workspace to use correct token
      let userWorkspaceId = null;
      try {
        const userInfo = await app.client.users.info({ user: userId });
        userWorkspaceId = userInfo.user.team_id;
        console.log(`🏢 User ${userId} is from workspace: ${userWorkspaceId}`);
      } catch (userError) {
        console.log(`⚠️ Could not get user workspace info:`, userError.message);
      }

      // Check if the channel is accessible before attempting to post
      const workspaceToken = getWorkspaceToken(userWorkspaceId);
      const workspaceClient = new app.client.constructor({
        token: workspaceToken,
      });

      const channelValidation = await validateChannelAccess(
        workspaceClient,
        dest.channel
      );
      if (!channelValidation.accessible) {
        console.error(
          `❌ Channel ${dest.channel} not accessible:`,
          channelValidation.error
        );
        console.error(
          `💡 User ${userId} needs to reconfigure their destination channel`
        );

        // Clear the invalid destination
        await updateStore((store) => {
          delete store.destinations[userId];
        });

        return res.status(404).json({
          ok: false,
          error: "channel_not_found",
          message:
            "Channel not accessible - user needs to reconfigure destination",
          user: userId,
        });
      }
      console.log(`✅ Channel ${dest.channel} is accessible`);

      const alertData = summarizeBlocks(riskInsight);

      // Try to post the message using workspace-specific token
      let post;
      try {
        post = await workspaceClient.chat.postMessage({
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
            // Try to join the channel using workspace token
            await workspaceClient.conversations.join({
              channel: dest.channel,
            });
            console.log(`✅ Successfully joined channel ${dest.channel}`);

            // Retry posting the message
            post = await workspaceClient.chat.postMessage({
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

            // If join fails, clear the invalid destination
            console.log(`🧹 Clearing invalid destination for user ${userId}`);
            await updateStore((store) => {
              delete store.destinations[userId];
            });

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
        await saveStore(STORE);
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
            .warning { background: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 4px; margin: 20px 0; }
            .warning::before { content: "⚠️ "; font-weight: bold; }
        </style>
    </head>
    <body>
        <h1>🤖 Hypernative Slack Bot</h1>
        <p>Get personalized Hypernative alerts delivered directly to your Slack channels.</p>
        
        <div class="warning">
            <strong>Important:</strong> For the best experience, install this bot in your own workspace. 
            If you're from a different workspace, you'll need to install it there to access the App Home feature.
        </div>
        
        <h3>Features:</h3>
        <div class="feature">Personal webhook URLs for each user</div>
        <div class="feature">Configurable alert destinations</div>
        <div class="feature">Interactive setup via DM or slash commands</div>
        <div class="feature">Accept/Deny transaction buttons</div>
        <div class="feature">App Home interface (when installed in your workspace)</div>
        
        <a href="${installUrl}" class="install-btn">Add to Slack</a>
        
        <h3>After Installation:</h3>
        <p>1. Use <code>/hypernative-setup</code> to configure your alerts</p>
        <p>2. Or DM the bot with "hi" to get started</p>
        <p>3. Get your unique webhook URL and add it to Hypernative</p>
        <p>4. Visit the bot's profile to access the App Home interface</p>
        
        <h3>Cross-Workspace Users:</h3>
        <p>If you're from a different workspace, you can still use:</p>
        <ul>
            <li>Slash commands: <code>/hypernative-setup</code>, <code>/hypernative-config</code></li>
            <li>Webhook functionality (once configured)</li>
            <li>DM interactions (if accessible)</li>
        </ul>
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

    // Store workspace-specific token
    workspaceTokens.set(result.team.id, {
      token: result.access_token,
      team: result.team,
      bot: result.bot_user_id,
      user: result.authed_user?.id,
      scopes: result.scope,
      installedAt: new Date().toISOString(),
    });

    console.log(
      `✅ Stored workspace token for team: ${result.team.id} (${result.team.name})`
    );
    console.log(`📋 Total workspaces with tokens: ${workspaceTokens.size}`);

    // Save to installations store (you might want to use a database for production)
    await updateStore((store) => {
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
    workspaceTokens: workspaceTokens.size,
    installedWorkspaces: Array.from(workspaceTokens.keys()),
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
  console.log(
    `   Storage: ${
      USE_GIST_STORAGE
        ? `GitHub Gist (${GIST_ID})`
        : `Local file (${PERSIST_PATH})`
    }`
  );

  // Initialize storage first
  await initializeStorage();

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
