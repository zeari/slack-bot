// Interactive handlers (buttons, modals, dropdowns)
import { gunzipSync } from "zlib";
import {
  getUserWebhookURL,
  translateUserId,
  validateChannelAccess,
} from "../utils/helpers.js";
import { publishHomeView } from "./appHome.js";

// Helper function to decompress RI data from metadata
function decompressRIMetadata(metadata) {
  if (!metadata || !metadata.compressed) {
    // Legacy uncompressed data or direct riskInsight object
    return metadata?.riskInsight || metadata;
  }

  try {
    const buffer = Buffer.from(metadata.data, "base64");
    const decompressed = gunzipSync(buffer);
    const jsonStr = decompressed.toString("utf-8");
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error("Failed to decompress metadata:", error);
    return null;
  }
}

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
              text: "📝 *Instructions:*\n• Use this URL in your Hypernative configuration\n• Only you can use this URL - it routes alerts to your chosen destination\n• Visit the *Home* tab to view or update your settings anytime",
            },
          },
        ],
      });

      // Force update the App Home to reflect the new configuration
      await publishHomeView(
        client,
        userId,
        store,
        updateStoreWithChangeDetection
      );
      console.log(
        `🔄 App Home refreshed for user: ${userId} after configuration update`
      );
    } catch (e) {
      console.error("Post setup ack failed:", e);
    }
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

    // Retrieve and decompress the RI data from message metadata
    const eventPayload = body.message?.metadata?.event_payload;
    const riskInsight = decompressRIMetadata(eventPayload);

    console.log(
      `🔍 Retrieved RI data from metadata for ${selectedValue}:`,
      riskInsight ? "Available" : "Not available"
    );
    if (riskInsight) {
      console.log(
        `🔍 TriggeringRis count:`,
        riskInsight.triggeringRis?.length || 0
      );
    }

    try {
      switch (selectedValue) {
        case "findings":
          // Extract information from triggeringRis
          let findingsBlocks = [];

          if (
            riskInsight?.triggeringRis &&
            riskInsight.triggeringRis.length > 0
          ) {
            // Process each triggering RI
            riskInsight.triggeringRis.forEach((triggeringRi, index) => {
              // Get severity with emoji
              const severityEmoji = {
                Critical: ":red_circle:",
                High: ":warning:",
                Medium: ":large_orange_diamond:",
                Low: ":large_blue_diamond:",
                Info: ":information_source:",
                Warn: ":warning:",
              };
              const severity = triggeringRi.severity || "Unknown";
              const severityIcon = severityEmoji[severity] || ":grey_question:";

              // Add context block with severity
              findingsBlocks.push({
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: `${severityIcon} *${severity}*`,
                  },
                ],
              });

              // Add headline/details section
              if (triggeringRi.details) {
                findingsBlocks.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: triggeringRi.details,
                  },
                });
              }

              // Build fields for the details row
              const fields = [];

              // Extract context details or use detailsParams
              const hasContext =
                triggeringRi.context && triggeringRi.context.length > 0;
              const hasDetailsParams = triggeringRi.detailsParams;

              let fromValue, toValue, valueAmount;

              if (hasContext) {
                const fromContext = triggeringRi.context.find(
                  (c) => c.title === "From"
                );
                const toContext = triggeringRi.context.find(
                  (c) => c.title === "To"
                );
                const valueContext = triggeringRi.context.find(
                  (c) => c.title === "Value"
                );

                fromValue = fromContext?.value;
                toValue = toContext?.value;
                valueAmount = valueContext?.value;
              }

              // Fallback to detailsParams if context not available
              if (!fromValue && hasDetailsParams) {
                fromValue = triggeringRi.detailsParams.fromAddress;
                toValue = triggeringRi.detailsParams.toAddress;
              }

              // Add "From" field
              if (fromValue) {
                const shortFrom =
                  fromValue.length > 10
                    ? `${fromValue.substring(0, 6)}...${fromValue.substring(
                        fromValue.length - 4
                      )}`
                    : fromValue;
                fields.push({
                  type: "mrkdwn",
                  text: `*From:* \`${shortFrom}\``,
                });
              }

              // Add "To" field
              if (toValue) {
                const shortTo =
                  toValue.length > 10
                    ? `${toValue.substring(0, 6)}...${toValue.substring(
                        toValue.length - 4
                      )}`
                    : toValue;

                // Check if this is a scammer address
                const isScammer = triggeringRi.involvedAssets?.some(
                  (asset) =>
                    asset.address === toValue &&
                    (asset.involvement?.toLowerCase().includes("scam") ||
                      asset.involvement?.toLowerCase().includes("phishing"))
                );

                fields.push({
                  type: "mrkdwn",
                  text: `*To:* ${
                    isScammer ? ":rotating_light:" : ""
                  } \`${shortTo}\`${isScammer ? " *(Scammer)*" : ""}`,
                });
              }

              // Add value if available
              if (valueAmount) {
                fields.push({
                  type: "mrkdwn",
                  text: `*Value:* ${valueAmount}`,
                });
              }

              // Add fields section if we have any fields
              if (fields.length > 0) {
                findingsBlocks.push({
                  type: "section",
                  fields: fields,
                });
              }

              // Add divider between multiple findings (except after the last one)
              if (index < riskInsight.triggeringRis.length - 1) {
                findingsBlocks.push({
                  type: "divider",
                });
              }
            });
          } else {
            // Fallback if no triggeringRis data available
            findingsBlocks = [
              {
                type: "context",
                elements: [
                  {
                    type: "mrkdwn",
                    text: ":warning: *No detailed findings available*",
                  },
                ],
              },
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "Detailed risk information is not available for this alert.",
                },
              },
            ];
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Findings details",
            blocks: findingsBlocks,
          });
          break;

        case "interpretation_summary":
          let summaryBlocks = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Interpretation Summary*",
              },
            },
          ];

          if (riskInsight) {
            // Add the main interpretation summary
            if (riskInsight.interpretationSummary) {
              summaryBlocks.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: riskInsight.interpretationSummary,
                },
              });
            }

            // Add parsed actions if available
            if (
              riskInsight.parsedActions &&
              riskInsight.parsedActions.length > 0
            ) {
              summaryBlocks.push({
                type: "divider",
              });
              summaryBlocks.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: "*Parsed Actions:*",
                },
              });

              riskInsight.parsedActions.forEach((action) => {
                let actionText = `*${
                  action.displayType || action.parsedAction
                }*`;

                if (action.displayAmount) {
                  actionText += `\n• Amount: ${action.displayAmount}`;
                }

                if (action.asset) {
                  actionText += `\n• Asset: ${action.asset}`;
                }

                if (
                  action.displayAddresses &&
                  action.displayAddresses.length > 0
                ) {
                  action.displayAddresses.forEach((addr) => {
                    const shortAddr =
                      addr.address?.length > 10
                        ? `${addr.address.substring(
                            0,
                            6
                          )}...${addr.address.substring(
                            addr.address.length - 4
                          )}`
                        : addr.address;
                    const label = addr.alias || shortAddr;
                    actionText += `\n• ${addr.role}: \`${label}\``;
                  });
                }

                summaryBlocks.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: actionText,
                  },
                });
              });
            }

            // Add transaction hash if available
            if (riskInsight.txnHash) {
              summaryBlocks.push({
                type: "divider",
              });
              const shortHash =
                riskInsight.txnHash.length > 20
                  ? `${riskInsight.txnHash.substring(
                      0,
                      10
                    )}...${riskInsight.txnHash.substring(
                      riskInsight.txnHash.length - 8
                    )}`
                  : riskInsight.txnHash;
              summaryBlocks.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*Transaction Hash:* \`${shortHash}\``,
                },
              });
            }
          } else {
            summaryBlocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: "No interpretation summary available.",
              },
            });
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Interpretation Summary",
            blocks: summaryBlocks,
          });
          break;

        case "balance_changes":
          let balanceBlocks = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Balance Changes*",
              },
            },
          ];

          if (riskInsight) {
            // Try to get balance changes from context
            const balanceContext = riskInsight.context?.find(
              (c) =>
                c.title === "Balance Changed" ||
                c.title === "From Balance Changed"
            );

            let balanceData = null;
            if (balanceContext?.value) {
              try {
                balanceData = JSON.parse(balanceContext.value);
              } catch (e) {
                console.log("Failed to parse balance data:", e);
              }
            }

            if (balanceData) {
              // If balance data is an object with addresses as keys
              if (
                typeof balanceData === "object" &&
                !Array.isArray(balanceData)
              ) {
                Object.entries(balanceData).forEach(([address, changes]) => {
                  const shortAddr =
                    address.length > 10
                      ? `${address.substring(0, 6)}...${address.substring(
                          address.length - 4
                        )}`
                      : address;

                  // Find the involvement type for this address
                  const asset = riskInsight.involvedAssets?.find(
                    (a) => a.address === address
                  );
                  const involvement = asset?.involvementType || "";

                  balanceBlocks.push({
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `*Address:* \`${shortAddr}\` ${
                        involvement ? `_${involvement}_` : ""
                      }`,
                    },
                  });

                  // Process each balance change
                  const changeArray = Array.isArray(changes)
                    ? changes
                    : [changes];
                  changeArray.forEach((change) => {
                    const isNegative =
                      change.change_type === "send" ||
                      parseFloat(change.amount) < 0;
                    const emoji = isNegative ? "🔴" : "🟢";
                    const sign =
                      isNegative && !change.amount.toString().startsWith("-")
                        ? "-"
                        : "";
                    const usdValue = change.usd_value
                      ? `($${Math.abs(parseFloat(change.usd_value)).toFixed(
                          2
                        )})`
                      : "";

                    balanceBlocks.push({
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: `${emoji} \`${sign}${change.amount}\` *${change.token_symbol}* ${usdValue}`,
                      },
                    });
                  });

                  balanceBlocks.push({
                    type: "divider",
                  });
                });
              } else if (Array.isArray(balanceData)) {
                // If balance data is an array
                balanceData.forEach((change) => {
                  const isNegative =
                    change.change_type === "send" ||
                    parseFloat(change.amount) < 0;
                  const emoji = isNegative ? "🔴" : "🟢";
                  const sign =
                    isNegative && !change.amount.toString().startsWith("-")
                      ? "-"
                      : "";
                  const usdValue = change.usd_value
                    ? `($${Math.abs(parseFloat(change.usd_value)).toFixed(2)})`
                    : "";

                  balanceBlocks.push({
                    type: "section",
                    text: {
                      type: "mrkdwn",
                      text: `${emoji} \`${sign}${change.amount}\` *${change.token_symbol}* ${usdValue}`,
                    },
                  });
                });
              }
            } else {
              // Fallback to parsed actions
              if (
                riskInsight.parsedActions &&
                riskInsight.parsedActions.length > 0
              ) {
                riskInsight.parsedActions.forEach((action) => {
                  if (action.displayAmount) {
                    balanceBlocks.push({
                      type: "section",
                      text: {
                        type: "mrkdwn",
                        text: `*${action.displayType || "Transfer"}:* ${
                          action.displayAmount
                        }`,
                      },
                    });
                  }
                });
              } else {
                balanceBlocks.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: "No balance change information available.",
                  },
                });
              }
            }
          } else {
            balanceBlocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: "No balance change information available.",
              },
            });
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Balance Changes",
            blocks: balanceBlocks,
          });
          break;

        case "involved_addresses":
          let addressBlocks = [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "*Involved Addresses*",
              },
            },
          ];

          if (
            riskInsight?.involvedAssets &&
            riskInsight.involvedAssets.length > 0
          ) {
            // Group addresses by involvement type
            const addressGroups = {};

            riskInsight.involvedAssets.forEach((asset) => {
              const involvement = asset.involvementType || "Unknown";
              if (!addressGroups[involvement]) {
                addressGroups[involvement] = [];
              }
              addressGroups[involvement].push(asset);
            });

            // Display each group
            Object.entries(addressGroups).forEach(([involvement, assets]) => {
              addressBlocks.push({
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `*${involvement}:*`,
                },
              });

              assets.forEach((asset) => {
                const shortAddr =
                  asset.address?.length > 10
                    ? `${asset.address.substring(
                        0,
                        6
                      )}...${asset.address.substring(asset.address.length - 4)}`
                    : asset.address;

                const typeIcon = asset.type === "Wallet" ? "👤" : "📄";
                const chain = asset.chain ? ` (${asset.chain})` : "";

                addressBlocks.push({
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `${typeIcon} \`${shortAddr}\`${chain}`,
                  },
                });
              });

              addressBlocks.push({
                type: "divider",
              });
            });

            // Remove last divider
            if (addressBlocks[addressBlocks.length - 1].type === "divider") {
              addressBlocks.pop();
            }
          } else {
            addressBlocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: "No involved addresses available.",
              },
            });
          }

          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Involved Addresses",
            blocks: addressBlocks,
          });
          break;

        case "tag_teammate":
          await client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "Tag Teammate",
            blocks: [
              {
                type: "section",
                block_id: "title",
                text: {
                  type: "mrkdwn",
                  text: "*Tag Teammate*",
                },
              },
              {
                type: "section",
                block_id: "picker_row",
                text: {
                  type: "mrkdwn",
                  text: "Select a Person…",
                },
                accessory: {
                  type: "users_select",
                  action_id: "select_user",
                  placeholder: {
                    type: "plain_text",
                    text: "Select Person...",
                  },
                },
              },
              {
                type: "actions",
                block_id: "confirm_or_cancel",
                elements: [
                  {
                    type: "button",
                    action_id: "confirm_tag",
                    text: {
                      type: "plain_text",
                      text: "✅ Confirm",
                      emoji: true,
                    },
                    value: "confirm_tag",
                  },
                  {
                    type: "button",
                    action_id: "cancel_tag",
                    text: {
                      type: "plain_text",
                      text: "❌ Cancel",
                      emoji: true,
                    },
                    value: "cancel_tag",
                  },
                ],
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

  // Handle user selection in tag teammate flow (just acknowledge, no action needed)
  app.action("select_user", async ({ ack }) => {
    await ack();
  });

  // Handle confirm tag button - actually tag the selected user
  app.action("confirm_tag", async ({ ack, body, client }) => {
    await ack();
    const channel = body.channel?.id;
    const ts = body.message?.ts;

    try {
      // Find the selected user from the message's blocks
      const pickerBlock = body.message.blocks.find(
        (block) => block.block_id === "picker_row"
      );

      let selectedUserId = null;
      if (pickerBlock?.accessory?.selected_user) {
        selectedUserId = pickerBlock.accessory.selected_user;
      }

      if (selectedUserId) {
        // Post a message tagging the user
        await client.chat.postMessage({
          channel,
          thread_ts: ts,
          text: `<@${selectedUserId}> - You've been tagged by <@${body.user.id}> to review this transaction.`,
        });

        // Update the original message to show confirmation
        await client.chat.update({
          channel,
          ts: body.message.ts,
          text: "Tag Teammate",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Tagged <@${selectedUserId}>* by <@${body.user.id}>`,
              },
            },
          ],
        });

        console.log(
          `✅ User ${body.user.id} tagged ${selectedUserId} in channel ${channel}`
        );
      } else {
        // No user selected
        await client.chat.postMessage({
          channel,
          thread_ts: ts,
          text: "❌ Please select a person first before confirming.",
        });
      }
    } catch (error) {
      console.error("Error confirming tag:", error);
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `❌ Failed to tag teammate: ${error.message}`,
      });
    }
  });

  // Handle cancel tag button
  app.action("cancel_tag", async ({ ack, body, client }) => {
    await ack();
    const channel = body.channel?.id;
    const ts = body.message?.ts;

    try {
      // Update the message to show cancellation
      await client.chat.update({
        channel,
        ts,
        text: "Tag Teammate",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `❌ *Tag cancelled* by <@${body.user.id}>`,
            },
          },
        ],
      });

      console.log(
        `❌ User ${body.user.id} cancelled tagging in channel ${channel}`
      );
    } catch (error) {
      console.error("Error cancelling tag:", error);
    }
  });
}
