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

// Validate Slack token and return auth info or error
export async function validateSlackToken(client) {
  try {
    const auth = await client.auth.test();
    return {
      valid: true,
      auth,
      error: null,
    };
  } catch (error) {
    console.log(`⚠️ Token validation failed:`, error?.data || error?.message);
    return {
      valid: false,
      auth: null,
      error: error?.data || error,
    };
  }
}

// Check if error is due to token expiration
export function isTokenExpiredError(error) {
  return (
    error?.data?.error === "token_expired" || error?.error === "token_expired"
  );
}

// Create standardized token expiration response
export function createTokenExpiredResponse(userId, workspaceId) {
  return {
    ok: false,
    error: "token_expired",
    message:
      "Bot token has expired. Please reinstall the bot in your workspace.",
    user: userId,
    workspace: workspaceId,
    reinstall_url: `${
      process.env.BASE_URL || "http://localhost:3000"
    }/slack/install`,
  };
}

// Clean up expired installations from storage
export async function cleanupExpiredInstallation(
  store,
  updateStoreWithChangeDetection,
  workspaceId
) {
  try {
    console.log(
      `🧹 Cleaning up expired installation for workspace: ${workspaceId}`
    );
    await updateStoreWithChangeDetection(
      store,
      (store) => {
        if (store.installations && store.installations[workspaceId]) {
          delete store.installations[workspaceId];
          console.log(
            `🗑️ Removed expired installation for workspace: ${workspaceId}`
          );
        }
      },
      `Cleanup expired installation for workspace ${workspaceId}`
    );
  } catch (error) {
    console.error(
      `❌ Failed to cleanup expired installation for workspace ${workspaceId}:`,
      error
    );
  }
}

// Refresh an expired Slack token using refresh token
export async function refreshSlackToken(refreshToken, clientId, clientSecret) {
  try {
    console.log(`🔄 Attempting to refresh Slack token`);

    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "Token refresh failed");
    }

    console.log(
      `✅ Token refreshed successfully for team: ${
        data.team?.name || "unknown"
      }`
    );

    return {
      success: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null,
      team: data.team,
      bot: data.bot,
      user: data.authed_user,
    };
  } catch (error) {
    console.error(`❌ Token refresh failed:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Check if a token is expired or about to expire
export function isTokenExpired(expiresAt, bufferMinutes = 5) {
  if (!expiresAt) return false; // No expiration date means it doesn't expire

  const expirationTime = new Date(expiresAt);
  const bufferTime = new Date(Date.now() + bufferMinutes * 60 * 1000);

  return expirationTime <= bufferTime;
}

// Get a valid token, refreshing if necessary
export async function getValidToken(
  installation,
  clientId,
  clientSecret,
  updateStoreWithChangeDetection,
  store
) {
  const now = new Date();

  // Check if token is expired or about to expire
  if (isTokenExpired(installation.expiresAt)) {
    console.log(
      `🔄 Token is expired or expiring soon for workspace: ${installation.team?.id}`
    );

    if (installation.refreshToken) {
      const refreshResult = await refreshSlackToken(
        installation.refreshToken,
        clientId,
        clientSecret
      );

      if (refreshResult.success) {
        // Update the installation with new token
        const updatedInstallation = {
          ...installation,
          bot: {
            ...installation.bot,
            token: refreshResult.accessToken,
            refreshToken: refreshResult.refreshToken,
            expiresAt: refreshResult.expiresAt,
          },
          refreshToken: refreshResult.refreshToken,
          expiresAt: refreshResult.expiresAt,
        };

        // Save the updated installation
        await updateStoreWithChangeDetection(
          store,
          (store) => {
            if (
              store.installations &&
              store.installations[installation.team.id]
            ) {
              store.installations[installation.team.id] = updatedInstallation;
            }
          },
          `Token refresh for workspace ${installation.team.id}`
        );

        console.log(
          `✅ Token refreshed and saved for workspace: ${installation.team.id}`
        );
        return refreshResult.accessToken;
      } else {
        console.log(
          `❌ Token refresh failed for workspace: ${installation.team.id}`
        );
        throw new Error(`Token refresh failed: ${refreshResult.error}`);
      }
    } else {
      console.log(
        `❌ No refresh token available for workspace: ${installation.team.id}`
      );
      throw new Error("No refresh token available");
    }
  }

  // Token is still valid
  return installation.bot?.token;
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
