// Webhook handlers for receiving Hypernative alerts
import express from "express";
import { WebClient } from "@slack/web-api";
import { EXTERNAL_WEBHOOK_TOKEN } from "../config/index.js";
import { summarizeBlocks } from "../utils/messageFormatter.js";
import {
  parseHypernativePayload,
  validateChannelAccess,
  validateSlackToken,
  isTokenExpiredError,
  createTokenExpiredResponse,
  cleanupExpiredInstallation,
  getValidToken,
} from "../utils/helpers.js";
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from "../config/index.js";

// External webhook to receive Hypernative POSTs
export function setupWebhookRoutes(
  receiver,
  app,
  store,
  updateStoreWithChangeDetection,
  installationStore
) {
  // User-specific webhook endpoint
  receiver.router.post(
    "/webhook/:token",
    express.json({ limit: "2mb" }),
    async (req, res) => {
      try {
        const { token } = req.params;
        console.log(`🎯 Received webhook request for token: ${token}`);

        // Ensure backward compatibility with existing storage
        if (!store.tokenToUser) {
          console.log(`❌ store.tokenToUser is missing`);
          return res.status(404).json({ ok: false, error: "token_not_found" });
        }

        console.log(`🔍 Looking for token: ${token}`);
        console.log(
          `🔍 Available tokens: ${Object.keys(store.tokenToUser).join(", ")}`
        );

        const userId = store.tokenToUser[token];
        if (!userId) {
          console.log(`❌ Token not found: ${token}`);
          console.log(`❌ Current tokenToUser mapping:`, store.tokenToUser);
          return res.status(404).json({ ok: false, error: "token_not_found" });
        }

        console.log(`✅ Token mapped to user: ${userId}`);

        const { riskInsight } = parseHypernativePayload(req.body);
        if (!riskInsight)
          return res.status(400).json({ ok: false, error: "bad_payload" });

        let dest = store.destinations[userId];
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
        console.log(`🔍 Destination details:`, dest);

        // Get a workspace-specific client for this destination
        // Start with the app's default client as a fallback; we'll try to resolve the correct team token below
        let workspaceClient = app.client;
        let userWorkspaceId = dest.workspaceId || dest.team_id;

        // Helper to extract a usable bot token from an installation record
        const extractToken = (installation) =>
          installation?.bot?.token || installation?.token || null; // support both shapes

        // Helper to get a valid token (with refresh if needed)
        const getValidTokenForInstallation = async (installation) => {
          if (!installation) return null;
          try {
            return await getValidToken(
              installation,
              SLACK_CLIENT_ID,
              SLACK_CLIENT_SECRET,
              updateStoreWithChangeDetection,
              store
            );
          } catch (error) {
            console.log(
              `⚠️ Token refresh failed for installation:`,
              error.message
            );
            return installation?.bot?.token || installation?.token || null;
          }
        };

        // 1) If we *know* the team (workspace) on the destination, prefer that installation
        if (userWorkspaceId) {
          try {
            let installation;
            if (installationStore?.fetchInstallation) {
              installation = await installationStore.fetchInstallation({
                teamId: userWorkspaceId,
              });
            } else if (store?.installations?.[userWorkspaceId]) {
              installation = store.installations[userWorkspaceId];
            }
            const token = await getValidTokenForInstallation(installation);
            if (token) {
              workspaceClient = new WebClient(token);
              console.log(
                `🔑 Using workspace-specific token for ${userWorkspaceId}`
              );
            } else {
              console.log(
                `⚠️ No bot token found for workspace ${userWorkspaceId}`
              );
            }
          } catch (installError) {
            console.log(
              `⚠️ Could not resolve installation for workspace ${userWorkspaceId}:`,
              installError.message
            );
          }
        }

        // 2) If team is still unknown OR the token didn't work, try to *discover* the right token by probing
        //    each known installation until one can see the destination channel. This handles older destinations
        //    that didn’t persist a workspaceId.
        let resolvedByProbe = false;
        if (!userWorkspaceId || workspaceClient === app.client) {
          const installations = store?.installations || {};
          for (const [teamId, inst] of Object.entries(installations)) {
            const token = await getValidTokenForInstallation(inst);
            if (!token) continue;
            const probeClient = new WebClient(token);
            try {
              // If this token can see the channel, this is the right workspace
              await probeClient.conversations.info({ channel: dest.channel });
              workspaceClient = probeClient;
              userWorkspaceId = teamId;
              resolvedByProbe = true;
              console.log(`🧭 Resolved workspace by probing: ${teamId}`);
              break;
            } catch (e) {
              // Ignore and keep trying other installations
            }
          }
        }

        // 3) Validate token before attempting to post
        const tokenValidation = await validateSlackToken(workspaceClient);
        if (!tokenValidation.valid) {
          if (isTokenExpiredError(tokenValidation.error)) {
            console.log(
              `⚠️ Token expired during validation for user ${userId} in workspace ${userWorkspaceId}`
            );
            // Clean up the expired installation
            if (userWorkspaceId) {
              await cleanupExpiredInstallation(
                store,
                updateStoreWithChangeDetection,
                userWorkspaceId
              );
            }
            return res
              .status(401)
              .json(createTokenExpiredResponse(userId, userWorkspaceId));
          }
          console.log(
            "auth.test failed for selected workspace client:",
            tokenValidation.error?.data || tokenValidation.error?.message
          );
        } else {
          const auth = tokenValidation.auth;
          console.log(
            "🔎 posting with token team:",
            auth.team_id,
            "user:",
            auth.user_id,
            "dest.team:",
            userWorkspaceId || "(unknown)"
          );
          if (userWorkspaceId && auth.team_id !== userWorkspaceId) {
            console.log(
              `❌ token/team mismatch (${auth.team_id} != ${userWorkspaceId})`
            );
          }
        }

        console.log(`🔍 Risk insight data:`, riskInsight);
        const alertData = summarizeBlocks(riskInsight);
        console.log(`🔍 Alert data:`, alertData);

        // Try to post the message using workspace-specific token
        let post;
        try {
          console.log(
            `📤 Attempting to post message to channel ${dest.channel}`
          );
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
          // Handle token expiration specifically
          if (isTokenExpiredError(error)) {
            console.log(
              `⚠️ Token expired for user ${userId} in workspace ${userWorkspaceId}`
            );
            // Clean up the expired installation
            if (userWorkspaceId) {
              await cleanupExpiredInstallation(
                store,
                updateStoreWithChangeDetection,
                userWorkspaceId
              );
            }
            return res
              .status(401)
              .json(createTokenExpiredResponse(userId, userWorkspaceId));
          }
          if (error.data && error.data.error === "channel_not_found") {
            console.log(
              `🔄 Channel not found, attempting to join channel ${dest.channel}`
            );
            try {
              // First, check if it's a public channel we can join
              const channelInfo = await workspaceClient.conversations.info({
                channel: dest.channel,
              });

              if (channelInfo.channel.is_private) {
                console.log(
                  `❌ Channel ${dest.channel} is private - bot needs to be invited`
                );
                return res.status(404).json({
                  ok: false,
                  error: "private_channel",
                  message:
                    "Channel is private - please invite the bot with /invite @hypernative",
                  user: userId,
                });
              }

              // Try to join the public channel
              await workspaceClient.conversations.join({
                channel: dest.channel,
              });
              console.log(
                `✅ Successfully joined public channel ${dest.channel}`
              );

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
              // Check if the join error is also due to token expiration
              if (isTokenExpiredError(joinError)) {
                console.log(
                  `⚠️ Token expired during channel join for user ${userId} in workspace ${userWorkspaceId}`
                );
                // Clean up the expired installation
                if (userWorkspaceId) {
                  await cleanupExpiredInstallation(
                    store,
                    updateStoreWithChangeDetection,
                    userWorkspaceId
                  );
                }
                return res
                  .status(401)
                  .json(createTokenExpiredResponse(userId, userWorkspaceId));
              }
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
          await updateStoreWithChangeDetection(
            store,
            (store) => {},
            "webhook error recovery"
          );
        } catch (saveError) {
          console.error("Failed to save after user webhook error:", saveError);
        }
        return res.status(500).json({ ok: false, error: "internal_error" });
      }
    }
  );
}
