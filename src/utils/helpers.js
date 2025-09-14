// Utility helper functions
import { randomUUID } from "crypto";

// Format UTC timestamp
export const fmtUTC = (iso) => {
  try {
    if (!iso) return "Unknown time";
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").replace("Z", " UTC");
  } catch {
    return iso;
  }
};

// Generate user token
export async function getUserToken(userId, store, updateStore) {
  // Ensure backward compatibility with existing storage
  if (!store.userTokens) store.userTokens = {};
  if (!store.tokenToUser) store.tokenToUser = {};

  if (store.userTokens[userId]) {
    return store.userTokens[userId];
  }

  // Generate new token for user
  const token = randomUUID();
  await updateStore(store, (store) => {
    store.userTokens[userId] = token;
    store.tokenToUser[token] = userId;
  });

  return token;
}

// Get user webhook URL
export async function getUserWebhookURL(userId, baseURL, store, updateStore) {
  const token = await getUserToken(userId, store, updateStore);
  // Default to localhost for development, but allow override
  const defaultURL = process.env.BASE_URL || "http://localhost:3000";
  const finalURL = baseURL || defaultURL;
  return `${finalURL}/webhook/${token}`;
}

// Translate global user IDs to local IDs
export async function translateUserId(client, userId) {
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

// Validate if a channel is accessible
export async function validateChannelAccess(
  client,
  channelId,
  workspaceToken = null // This parameter is now ignored - client already has correct token
) {
  try {
    // The client provided by Bolt already has the correct workspace token
    const channelInfo = await client.conversations.info({
      channel: channelId,
    });

    // Check if it's a private channel and bot is not a member
    if (channelInfo.channel.is_private && !channelInfo.channel.is_member) {
      return {
        accessible: false,
        error: "not_in_channel",
        channel: channelInfo.channel,
        isPrivate: true,
      };
    }

    return { accessible: true, channel: channelInfo.channel };
  } catch (error) {
    if (error.data && error.data.error === "channel_not_found") {
      return { accessible: false, error: "channel_not_found" };
    }
    if (error.data && error.data.error === "not_in_channel") {
      return {
        accessible: false,
        error: "not_in_channel",
        isPrivate: true,
      };
    }
    return { accessible: false, error: error.message };
  }
}

// Get workspace-specific token
export function getWorkspaceToken(teamId, workspaceTokens) {
  const workspaceData = workspaceTokens.get(teamId);
  if (workspaceData && workspaceData.token) {
    console.log(`🔑 Using workspace-specific token for team: ${teamId}`);
    return workspaceData.token;
  }

  // Fallback to default token
  console.log(
    `⚠️ No workspace-specific token found for team: ${teamId}, using default token`
  );
  return process.env.SLACK_BOT_TOKEN;
}

// Create workspace-specific client
export function createWorkspaceClient(teamId, workspaceTokens, app) {
  const token = getWorkspaceToken(teamId, workspaceTokens);
  return new app.client.constructor({ token });
}

// Parse Hypernative payload
export function parseHypernativePayload(body) {
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
