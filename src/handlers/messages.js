// DM and message handlers
import {
  getUserWebhookURL,
  translateUserId,
  validateChannelAccess,
  getWorkspaceToken,
  createWorkspaceClient,
} from "../utils/helpers.js";

// Message handling for conversational setup
export function setupMessageHandlers(
  app,
  store,
  updateStoreWithChangeDetection
) {
  app.message(
    /^(hi|hello|hey|setup|config|configure|help)/i,
    async ({ message, client }) => {
      const userId = message.user;
      const channelId = message.channel;
      console.log(
        `💬 Received greeting/setup message from user ${userId}: "${message.text}"`
      );
      console.log(`📺 Message channel: ${channelId}`);

      const dest = store.destinations[userId];

      if (!dest || !dest.channel) {
        try {
          await client.chat.postMessage({
            channel: message.channel, // must be D...
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
        } catch (error) {
          console.log(
            `⚠️ DM reply failed for user ${userId} in ${channelId}:`,
            error?.data || error?.message
          );

          // Optional: probe channel existence with this token
          try {
            const info = await client.conversations.info({
              channel: channelId,
            });
            console.log(
              "🔍 conversations.info ok:",
              info.ok,
              "is_im:",
              info?.channel?.is_im
            );
          } catch (e) {
            console.log("🔍 conversations.info failed:", e?.data || e?.message);
            if (e?.data?.error === "channel_not_found") {
              console.log(
                `💡 Channel ${channelId} not found - confirms token/workspace mismatch`
              );
              console.log(
                `💡 User ${userId} needs to install the bot in their workspace first`
              );
              console.log(
                `🔗 Installation URL: ${process.env.BASE_URL}/slack/install`
              );
            }
          }
        }
      } else {
        const webhookURL = await getUserWebhookURL(
          userId,
          null,
          store,
          updateStoreWithChangeDetection
        );
        try {
          await client.chat.postMessage({
            channel: message.channel,
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
        } catch (error) {
          console.log(
            `⚠️ Could not send response to configured user ${userId}:`,
            error.message
          );
        }
      }
    }
  );

  // Handle requests for webhook URL
  app.message(/(webhook|url|link)/i, async ({ message, client }) => {
    const userId = message.user;
    const channelId = message.channel;
    console.log(`🔗 User ${userId} requested webhook URL: "${message.text}"`);
    console.log(`📺 Message channel: ${channelId}`);
    const dest = store.destinations[userId];

    if (!dest || !dest.channel) {
      try {
        await client.chat.postMessage({
          channel: message.channel,
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
      } catch (error) {
        console.log(
          `⚠️ Could not send webhook setup response to user ${userId} in channel ${channelId}:`,
          error.message
        );

        if (error.data && error.data.error === "channel_not_found") {
          console.log(
            `💡 Channel ${channelId} not found - user may be from a different workspace`
          );
          console.log(
            `💡 User ${userId} needs to install the bot in their workspace first`
          );
          console.log(
            `🔗 Installation URL: ${process.env.BASE_URL}/slack/install`
          );
        }
      }
    } else {
      const webhookURL = await getUserWebhookURL(
        userId,
        null,
        store,
        updateStoreWithChangeDetection
      );
      try {
        await client.chat.postMessage({
          channel: message.channel,
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
      } catch (error) {
        console.log(
          `⚠️ Could not send webhook URL to user ${userId} in channel ${channelId}:`,
          error.message
        );

        if (error.data && error.data.error === "channel_not_found") {
          console.log(
            `💡 Channel ${channelId} not found - user may be from a different workspace`
          );
          console.log(
            `💡 User ${userId} needs to install the bot in their workspace first`
          );
          console.log(
            `🔗 Installation URL: ${process.env.BASE_URL}/slack/install`
          );
        }
      }
    }
  });

  // Handle general questions and help
  app.message(/(how|what|where|status)/i, async ({ message, client }) => {
    const userId = message.user;
    const channelId = message.channel;
    const dest = store.destinations[userId];

    try {
      await client.chat.postMessage({
        channel: message.channel,
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
    } catch (error) {
      console.log(
        `⚠️ Could not send help response to user ${userId} in channel ${channelId}:`,
        error.message
      );

      if (error.data && error.data.error === "channel_not_found") {
        console.log(
          `💡 Channel ${channelId} not found - user may be from a different workspace`
        );
        console.log(
          `💡 User ${userId} needs to install the bot in their workspace first`
        );
        console.log(
          `🔗 Installation URL: ${process.env.BASE_URL}/slack/install`
        );
      }
    }
  });
}
