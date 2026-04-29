/**
 * /api/gh-summary.js
 * Core request handling for the /gh-summary Slack slash command.
 * Adapters provide platform-specific implementations of getSlackSecret,
 * processPR, and handleProcessingRequest.
 */

import { createAdapter } from "../src/adapters/index.js";
import { parseSlackRequest } from "../src/clients/slack.js";

const adapter = createAdapter(process.env.PROVIDER || "vercel");

const JSON_CT = { "Content-Type": "application/json" };

async function processRequest(rawBody, headers) {
  const slackSecret = await adapter.getSlackSecret();
  return parseSlackRequest(rawBody, headers, slackSecret);
}

// ── Vercel entry point ─────────────────────────────────────────────────────────

export default async function vercelHandler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("gh-summary bot is running");
  }

  const rawBody = await getRawBody(req);
  const result = await processRequest(rawBody, req.headers);

  if (result.unauthorized) return res.status(401).json({ error: "Unauthorized" });
  if (result.invalidInput) return res.json(result.invalidInput);

  adapter.processPR(result.prUrl, result.responseUrl);

  return res.json({
    response_type: "ephemeral",
    text: `⏳ Hey @${result.userName}, fetching PR summary…`,
  });
}

// ── Lambda entry point ─────────────────────────────────────────────────────────

export const handler = async (event) => {
  if (event.isProcessingRequest) {
    await adapter.handleProcessingRequest(event);
    return;
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 200, body: "gh-summary bot is running" };
  }

  const rawBody = event.body || "";
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const result = await processRequest(rawBody, headers);

  if (result.unauthorized) {
    return { statusCode: 401, headers: JSON_CT, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (result.invalidInput) {
    return { statusCode: 200, headers: JSON_CT, body: JSON.stringify(result.invalidInput) };
  }

  await adapter.processPR(result.prUrl, result.responseUrl);

  return {
    statusCode: 200,
    headers: JSON_CT,
    body: JSON.stringify({
      response_type: "ephemeral",
      text: `⏳ Hey @${result.userName}, fetching PR summary…`,
    }),
  };
};

// ── Utilities ──────────────────────────────────────────────────────────────────

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
