/**
 * Slack Client Helpers
 * Signature verification and message posting utilities
 */

import crypto from "crypto";

/**
 * Verify Slack request signature (HMAC-SHA256)
 */
export function verifySlackSignature(headers, rawBody, secret) {
  if (!secret) return false;
  
  const timestamp = headers["x-slack-request-timestamp"];
  const slackSig = headers["x-slack-signature"];
  
  if (!timestamp || !slackSig) return false;

  // Reject requests older than 5 minutes (replay attack protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    console.warn("Slack request timestamp too old, rejecting");
    return false;
  }

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed = 
    "v0=" +
    crypto.createHmac("sha256", secret).update(sigBase).digest("hex");

  if (computed.length !== slackSig.length) return false;
  
  return crypto.timingSafeEqual(
    Buffer.from(computed), 
    Buffer.from(slackSig)
  );
}

/**
 * Post message to Slack response_url
 */
export async function postToSlack(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("postToSlack error:", res.status, body);
  }
  return res;
}

export async function postToSlackInChunks(url, payload) {
  const { blocks, ...rest } = payload;
  if (!blocks || blocks.length <= 50) {
    return postToSlack(url, payload);
  }

  console.log("Splitting into multiple messages", { totalBlocks: blocks.length });
  const chunks = [];
  for (let i = 0; i < blocks.length; i += 50) {
    chunks.push(blocks.slice(i, i + 50));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunkPayload = { ...rest, response_type: "in_channel", blocks: chunks[i] };
    console.log(`Sending chunk ${i + 1}/${chunks.length}`, { blockCount: chunks[i].length });
    const res = await postToSlack(url, chunkPayload);
    console.log(`Chunk ${i + 1} sent`, { status: res.status });
  }
}

/**
 * Parse and validate an incoming Slack slash command body
 */
export function parseSlackRequest(rawBody, headers, slackSecret) {
  if (!verifySlackSignature(headers, rawBody, slackSecret)) {
    return { unauthorized: true };
  }

  const params = new URLSearchParams(rawBody);
  const prUrl = params.get("text")?.trim();
  const responseUrl = params.get("response_url");
  const userName = params.get("user_name") || "there";

  if (!prUrl || !prUrl.includes("github.com")) {
    return {
      invalidInput: {
        response_type: "ephemeral",
        text: "❌ Usage: `/gh-summary https://github.com/owner/repo/pull/123`",
      },
    };
  }

  return { ok: true, prUrl, responseUrl, userName };
}

/**
 * Format ISO date string for Slack display
 */
export function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
