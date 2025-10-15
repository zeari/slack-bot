// Slash commands and interactive handlers
import {
  getUserWebhookURL,
  translateUserId,
  validateChannelAccess,
} from "../utils/helpers.js";

export function setupCommandHandlers(
  app,
  store,
  updateStoreWithChangeDetection,
  workspaceTokens
) {
  // --- Interactivity: open setup modal ---
  app.action("open_setup_modal", async ({ ack, body, client }) => {
    await ack();
    const userId = body.user.id;

    // Check if user has existing configuration
    const existingDest = store.destinations[userId];
    const currentChannel = body.channel?.id;

    // Determine which channel to preselect
    let preselectedChannel = null;
    if (
      existingDest &&
      existingDest.channel &&
      existingDest.type === "channel"
    ) {
      // If user has existing channel config, preselect that
      preselectedChannel = existingDest.channel;
    } else if (currentChannel) {
      // Otherwise, preselect current channel
      preselectedChannel = currentChannel;
    }

    const channelSelectElement = {
      type: "conversations_select",
      action_id: "channel",
      response_url_enabled: false,
      filter: {
        include: ["public", "private", "mpim", "im"],
        exclude_bot_users: true,
      },
    };

    // Add initial option if we have a channel to preselect
    if (preselectedChannel) {
      channelSelectElement.initial_conversation = preselectedChannel;
    } else {
      channelSelectElement.default_to_current_conversation = true;
    }

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
            type: "section",
            text: {
              type: "mrkdwn",
              text: "Choose where you want to receive your Hypernative alerts:",
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "📢 *Destination:* Channel",
            },
          },
          {
            type: "input",
            block_id: "channel_b",
            label: {
              type: "plain_text",
              text: "Channel for alerts",
            },
            element: channelSelectElement,
          },
        ],
      },
    });
  });

  app.view("setup_destination_modal", async ({ ack, body, view, client }) => {
    await ack();
    const originalUserId = body.user.id;
    const channel = view.state.values.channel_b?.channel?.selected_conversation;

    // Translate global user ID to local ID if needed
    const userId = await translateUserId(client, originalUserId);

    // Validate that the selected channel is accessible
    if (!channel) {
      await client.chat.postMessage({
        channel: originalUserId,
        text: "❌ Setup failed",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `❌ *Setup Failed*\n\nPlease select a channel for your alerts.`,
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

    // The client provided by Bolt already has the correct workspace token
    const channelValidation = await validateChannelAccess(
      client,
      channel,
      null // No need to pass token - client already has the correct one
    );

    if (!channelValidation.accessible) {
      console.error(
        `❌ Selected channel ${channel} is not accessible:`,
        channelValidation.error
      );

      let errorMessage = `❌ *Channel Setup Failed*\n\nThe channel you selected (<#${channel}>) is not accessible.`;
      let actionText = "Try Again";

      if (
        channelValidation.error === "not_in_channel" ||
        channelValidation.isPrivate
      ) {
        errorMessage += `\n\n🔒 *This is a private channel and I'm not a member.*\n\nTo fix this:\n1. Go to the channel: <#${channel}>\n2. Type: \`/invite @hypernative\`\n3. Come back and try the setup again`;
        actionText = "Try Again";
      } else {
        errorMessage += `\n\nThis might be because:\n• The channel is from a different workspace\n• The bot doesn't have permission to access the channel\n• The channel no longer exists\n\nPlease try selecting a different channel.`;
      }

      // Use the client provided by Bolt (already has correct token)
      await client.chat.postMessage({
        channel: originalUserId,
        text: "❌ Channel setup failed",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: errorMessage,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: actionText },
                action_id: "open_setup_modal",
              },
            ],
          },
        ],
      });
      return;
    }

    const destinationChannel = channel;
    const destinationTypeText = `<#${channel}>`;

    // Get the workspace ID from the client context
    const workspaceId = client.team?.id || client.context?.teamId;

    await updateStoreWithChangeDetection(
      store,
      (store) => {
        store.destinations[userId] = {
          channel: destinationChannel,
          type: "channel",
          workspaceId: workspaceId,
        };
      },
      "setup command destination configuration"
    );

    const webhookURL = await getUserWebhookURL(
      userId,
      null,
      store,
      updateStoreWithChangeDetection
    );

    try {
      // Use the client provided by Bolt (already has correct token)
      await client.chat.postMessage({
        channel: originalUserId,
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
              text: `*Destination:* ${destinationTypeText}\n*Your unique webhook URL:*\n\`${webhookURL}\``,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "📝 *Instructions:*\n• Use this URL in your Hypernative configuration\n• Only you can use this URL - it routes alerts to your chosen destination\n• Use `/hypernative-config` to view your settings anytime",
            },
          },
        ],
      });
    } catch (e) {
      console.error("Post setup ack failed:", e);
    }
  });

  // Action: setup DM destination directly - DISABLED
  // app.action("setup_dm_destination", async ({ ack, body, client }) => {
  //   // DM functionality has been removed - users must use channels only
  //   await ack();
  //   const originalUserId = body.user.id;
  //
  //   await client.chat.postMessage({
  //     channel: originalUserId,
  //     text: "❌ DM setup is no longer available",
  //     blocks: [
  //       {
  //         type: "section",
  //         text: {
  //           type: "mrkdwn",
  //           text: "❌ *DM setup is no longer available*\n\nPlease use the channel setup instead.",
  //         },
  //       },
  //       {
  //         type: "actions",
  //         elements: [
  //           {
  //             type: "button",
  //             text: { type: "plain_text", text: "Set Up Channel" },
  //             action_id: "open_setup_modal",
  //           },
  //         ],
  //       },
  //     ],
  //   });
  // });

  // Slash command: /hypernative-setup
  app.command("/hypernative-setup", async ({ ack, body, client }) => {
    await ack();

    // Use the client provided by Bolt (already has correct token)
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
    const dest = store.destinations[userId];

    if (!dest || !dest.channel) {
      // Use the client provided by Bolt (already has correct token)
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

    const webhookURL = await getUserWebhookURL(
      userId,
      null,
      store,
      updateStoreWithChangeDetection
    );

    // Use the client provided by Bolt (already has correct token)
    await client.chat.postMessage({
      channel: userId,
      text: "Your Hypernative configuration",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "📊 Your Hypernative Configuration",
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Destination:* ${
              dest.type === "dm"
                ? "Direct Message with the bot"
                : `<#${dest.channel}>`
            }\n*Your Webhook URL:*\n\`${webhookURL}\``,
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

  // --- Accept / Deny actions ---
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

      console.log(
        `✅ Transaction accepted by user ${body.user.id} for ${value}`
      );
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

  // --- More Info dropdown handlers ---
  app.action("more_info_dropdown", async ({ ack, body, client, action }) => {
    await ack();
    const selectedValue = action.selected_option.value;
    const channel = body.channel?.id;
    const ts = body.message?.ts;

    try {
      switch (selectedValue) {
        case "findings":
          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Findings details",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: ":warning: *Warn*",
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "An attacker *0x12354* already has permission to withdraw your *DogUSD* tokens, and most likely will take these tokens immediately after.",
                },
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*You will send:* :money_with_wings: *1000 USDC*\u2003\u2003*You will receive:* :inbox_tray: *1000 USDC*\u2003\u2003*Scammer's address:* *0x12354*",
                },
              },
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: {
                      type: "plain_text",
                      text: "More Info",
                      emoji: true,
                    },
                    action_id: "more_info",
                    value: "more_info_clicked",
                  },
                ],
              },
            ],
          });
          break;

        case "interpretation_summary":
          // Get interpretation summary from the original message
          const originalMessage = body.message;
          let interpretationSummary = "No interpretation summary available";

          if (
            originalMessage.attachments &&
            originalMessage.attachments[0]?.blocks
          ) {
            const textBlock = originalMessage.attachments[0].blocks.find(
              (block) =>
                block.type === "section" &&
                block.text?.text?.includes("*Summary:*")
            );
            if (textBlock) {
              const summaryMatch = textBlock.text.text.match(
                /\*Summary:\*\s*\n(.*?)(?=\n\*|$)/s
              );
              if (summaryMatch) {
                interpretationSummary = summaryMatch[1].trim();
              }
            }
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Interpretation Summary",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Interpretation Summary:*\n\n${interpretationSummary}`,
                },
              },
            ],
          });
          break;

        case "balance_changes":
          // Get balance changes from the original message
          let balanceChanges = "No balance changes available";

          if (
            originalMessage.attachments &&
            originalMessage.attachments[0]?.blocks
          ) {
            const textBlock = originalMessage.attachments[0].blocks.find(
              (block) =>
                block.type === "section" &&
                block.text?.text?.includes("*Balance Changes:*")
            );
            if (textBlock) {
              const balanceMatch = textBlock.text.text.match(
                /\*Balance Changes:\*\s*(.*?)(?=\n\*|$)/s
              );
              if (balanceMatch) {
                balanceChanges = balanceMatch[1].trim();
              }
            }
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Balance Changes",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Balance Changes:*\n\n${balanceChanges}`,
                },
              },
            ],
          });
          break;

        case "involved_addresses":
          // Get involved addresses from the original message
          let involvedAddresses = "No involved addresses available";

          if (
            originalMessage.attachments &&
            originalMessage.attachments[0]?.blocks
          ) {
            const textBlock = originalMessage.attachments[0].blocks.find(
              (block) =>
                block.type === "section" &&
                block.text?.text?.includes("*Source:*")
            );
            if (textBlock) {
              const sourceMatch = textBlock.text.text.match(
                /\*Source:\*\s*(.*?)(?=\n\*|$)/s
              );
              const destMatch = textBlock.text.text.match(
                /\*Destination:\*\s*(.*?)(?=\n\*|$)/s
              );

              let addresses = [];
              if (sourceMatch)
                addresses.push(`*Source:* ${sourceMatch[1].trim()}`);
              if (destMatch)
                addresses.push(`*Destination:* ${destMatch[1].trim()}`);

              if (addresses.length > 0) {
                involvedAddresses = addresses.join("\n");
              }
            }
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Involved Addresses",
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Involved Addresses:*\n\n${involvedAddresses}`,
                },
              },
            ],
          });
          break;

        default:
          console.log(`Unknown more info option: ${selectedValue}`);
      }

      console.log(
        `📋 More info posted for ${selectedValue} by user ${body.user.id}`
      );
    } catch (error) {
      console.error("Error posting more info:", error);
      // Fallback to posting a simple reply if the detailed post fails
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `📋 More info for ${selectedValue} requested by <@${body.user.id}>`,
      });
    }
  });
}
