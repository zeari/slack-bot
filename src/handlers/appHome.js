// App Home handler
import { MAX_HOME_VIEW_FAILURES } from "../config/index.js";
import { getUserWebhookURL, translateUserId } from "../utils/helpers.js";

// Track home view failures to disable if consistently failing
let homeViewFailures = 0;

export function setupAppHomeHandler(
  app,
  store,
  updateStoreWithChangeDetection,
  workspaceTokens
) {
  // --- App Home (when users visit the bot's profile/home tab) ---
  app.event("app_home_opened", async ({ event, client }) => {
    console.log("🏠 App home opened event received!");
    console.log("🏠 Event details:", JSON.stringify(event, null, 2));
    console.log("🏠 Timestamp:", new Date().toISOString());
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

    // The client provided by Bolt already has the correct workspace token
    let userInfo = null;
    try {
      userInfo = await client.users.info({ user: userId });
      userWorkspaceId = userInfo.user.team_id;
      console.log(`👤 User info retrieved:`, userInfo.user);
    } catch (error) {
      console.error(`❌ Cannot access user ${userId}:`, error);
      if (error.data && error.data.error === "user_not_found") {
        console.log(
          `🌍 User ${userId} not found - likely from different workspace`
        );
        console.log(
          `💡 User may need to install the bot in their workspace: ${
            process.env.BASE_URL || "http://localhost:3000"
          }/slack/install`
        );
      }
      console.log("🚫 Skipping home view - user not accessible");
      return;
    }

    // Translate global user ID to local ID if needed
    const localUserId = await translateUserId(client, userId);

    const dest = store.destinations[localUserId];

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
                      userId,
                      null,
                      store,
                      updateStoreWithChangeDetection
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
      console.log(
        `🔍 Attempting to publish home view for user: ${localUserId}`
      );
      console.log(`🔍 Home view structure:`, JSON.stringify(homeView, null, 2));

      console.log(
        `🔑 Using client provided by Bolt (already has correct token)`
      );

      const result = await client.views.publish({
        user_id: localUserId,
        view: homeView,
      });

      console.log(
        `✅ Successfully published home view for user: ${localUserId} (original: ${userId}) using correct token`,
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
}
