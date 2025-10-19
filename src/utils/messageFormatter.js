// Message formatting utilities
import { fmtUTC } from "./helpers.js";

export function summarizeBlocks(ri) {
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

  // Determine button text and order based on recommendation and severity
  const getButtonConfig = (normalizedRecommendation, severity) => {
    const lowerSeverity = severity?.toLowerCase() || "";

    // Check if it's a neutral recommendation (Warn or Notes)
    if (lowerSeverity === "warn" || lowerSeverity === "notes") {
      return {
        primaryButton: { text: "Accept", style: "primary" },
        secondaryButton: { text: "Deny", style: "danger" },
      };
    }

    // For strong recommendations
    if (normalizedRecommendation === "Accept it") {
      return {
        primaryButton: { text: "Accept (Recommended)", style: "primary" },
        secondaryButton: { text: "Deny", style: "danger" },
      };
    } else {
      return {
        primaryButton: { text: "Deny (Recommended)", style: "danger" },
        secondaryButton: { text: "Accept Anyway", style: "primary" },
      };
    }
  };

  const buttonConfig = getButtonConfig(normalizedRecommendation, severity);

  // Debug logging for button configuration
  console.log(
    `🔍 Button config for recommendation "${normalizedRecommendation}" and severity "${severity}":`,
    buttonConfig
  );

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

  const result = {
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
            style: buttonConfig.primaryButton.style,
            text: {
              type: "plain_text",
              text: buttonConfig.primaryButton.text,
              emoji: true,
            },
            action_id: buttonConfig.primaryButton.text.includes("Accept")
              ? "accept_txn"
              : "deny_txn",
            value: ri?.txnHash || ri?.id || "unknown",
          },
          {
            type: "button",
            style: buttonConfig.secondaryButton.style,
            text: {
              type: "plain_text",
              text: buttonConfig.secondaryButton.text,
              emoji: true,
            },
            action_id: buttonConfig.secondaryButton.text.includes("Accept")
              ? "accept_txn"
              : "deny_txn",
            value: ri?.txnHash || ri?.id || "unknown",
          },
          {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "More Info",
              emoji: true,
            },
            action_id: "more_info_dropdown",
            options: [
              {
                text: {
                  type: "plain_text",
                  text: "Findings",
                  emoji: true,
                },
                value: "findings",
              },
              {
                text: {
                  type: "plain_text",
                  text: "Interpretation Summary",
                  emoji: true,
                },
                value: "interpretation_summary",
              },
              {
                text: {
                  type: "plain_text",
                  text: "Balance Changes",
                  emoji: true,
                },
                value: "balance_changes",
              },
              {
                text: {
                  type: "plain_text",
                  text: "Involved addresses",
                  emoji: true,
                },
                value: "involved_addresses",
              },
              {
                text: {
                  type: "plain_text",
                  text: "Tag Teammate",
                  emoji: true,
                },
                value: "tag_teammate",
              },
            ],
          },
        ],
      },
    ],
    // Add colored stripe based on recommendation
    color: getColorByRecommendation(normalizedRecommendation),
  };

  // Debug logging for the final result
  console.log(`🔍 Generated message blocks:`, JSON.stringify(result, null, 2));

  return result;
}
