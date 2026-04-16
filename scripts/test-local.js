#!/usr/bin/env node
/**
 * scripts/test-local.js
 * Quick smoke test against your local dev server.
 * Usage: node scripts/test-local.js <pr-url>
 *
 * Requires your local server running: npm run dev
 */

import crypto from "crypto";

const PR_URL = process.argv[2] || "https://github.com/vercel/next.js/pull/1";
const SECRET = process.env.SLACK_SIGNING_SECRET || "test-secret";
const ENDPOINT = process.env.ENDPOINT || "http://localhost:3000/api/gh-summary";

const body = new URLSearchParams({
  text: PR_URL,
  response_url: "https://httpbin.org/post", // inspect response at httpbin
  user_name: "testuser",
  command: "/gh-summary",
}).toString();

const timestamp = Math.floor(Date.now() / 1000).toString();
const sigBase = `v0:${timestamp}:${body}`;
const signature =
  "v0=" + crypto.createHmac("sha256", SECRET).update(sigBase).digest("hex");

console.log(`\nPosting to ${ENDPOINT}`);
console.log(`PR URL: ${PR_URL}\n`);

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
  },
  body,
});

const text = await res.text();
console.log("Status:", res.status);
console.log("Response:", text);
console.log(
  "\n✅ Check https://httpbin.org/post in your browser for the async Slack payload."
);
