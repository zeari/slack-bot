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
