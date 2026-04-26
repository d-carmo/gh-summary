/**
 * /api/gh-summary.js
 * Vercel serverless function — handles the /gh-summary Slack slash command
 *
 * Flow:
 *  1. Verify Slack request signature
 *  2. Acknowledge immediately (Slack requires < 3s)
 *  3. Async: fetch PR data from GitHub + summarize with Claude
 *  4. Post formatted result back to Slack via response_url
 */

import { waitUntil } from "@vercel/functions";
import {
  parsePRUrl,
  verifySlackSignature,
  buildSlackBlocks,
} from "../lib/utils.js";

export const config = {
  runtime: "nodejs",
  api: { bodyParser: false }, // we need raw body for HMAC verification
};

// ── Entry point ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("gh-summary bot is running");
  }

  const rawBody = await getRawBody(req);

  // Reject requests with invalid Slack signatures
  if (!verifySlackSignature(req.headers, rawBody, process.env.SLACK_SIGNING_SECRET)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const params = new URLSearchParams(rawBody);
  const prUrl = params.get("text")?.trim();
  const responseUrl = params.get("response_url");
  const userName = params.get("user_name") || "there";

  // Validate input before doing anything async
  if (!prUrl || !prUrl.includes("github.com")) {
    return res.json({
      response_type: "ephemeral",
      text: "❌ Usage: `/gh-summary https://github.com/owner/repo/pull/123`",
    });
  }

  // Acknowledge Slack immediately, then work async
  res.json({
    response_type: "ephemeral",
    text: `⏳ Hey @${userName}, fetching PR summary…`,
  });

  // waitUntil keeps the Vercel function alive after the response is sent
  waitUntil(
    processPR(prUrl, responseUrl).catch((err) => {
      console.error("processPR error:", err);
      postToSlack(responseUrl, { text: `❌ Unexpected error: ${err.message}` });
    })
  );
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

async function processPR(prUrl, responseUrl) {
  const { owner, repo, number } = parsePRUrl(prUrl);

  // Fetch PR metadata, discussion, and file list in parallel
  const [pr, comments, reviews, reviewComments, files] = await Promise.all([
    gh(`/repos/${owner}/${repo}/pulls/${number}`),
    gh(`/repos/${owner}/${repo}/issues/${number}/comments`),
    gh(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
    gh(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`),
    gh(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
  ]);

  // CI checks require the head SHA from the PR response
  const ciData = await gh(
    `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`
  );

  const summaryBlocks = await summarizeWithClaude(pr, files, comments, reviews, reviewComments);
  const blocks = buildSlackBlocks(pr, ciData.check_runs ?? [], summaryBlocks);

  await postToSlack(responseUrl, {
    response_type: "in_channel",
    blocks,
  });
}

// ── GitHub API ────────────────────────────────────────────────────────────────

async function gh(path, retries = 3) {
  const url = `https://api.github.com${path}`;
  const opts = {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gh-summary-slack-bot/1.0",
    },
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status} on ${path}: ${body}`);
      }
      return res.json();
    } catch (err) {
      const isNetworkErr = err.cause?.code === "ECONNRESET" || err.cause?.code === "ECONNREFUSED";
      if (isNetworkErr && attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ── Claude AI summary ─────────────────────────────────────────────────────────

async function summarizeWithClaude(pr, files, comments, reviews, reviewComments) {
  const aiMaxTokens = parseInt(process.env.MAX_TOKENS, 10) || 1000;
  const errorSection = [{ title: null, text: "_Could not generate AI summary._" }];

  const cap = (arr, n) => (arr.length > n ? arr.slice(-n) : arr);
  const truncateBody = (o, limit = 500) =>
    o.body ? { ...o, body: o.body.slice(0, limit) } : o;
  const slim = (arr, fields, bodyLimit) =>
    arr.map((o) => {
      const picked = Object.fromEntries(fields.map((f) => [f, o[f]]));
      return bodyLimit ? truncateBody(picked, bodyLimit) : picked;
    });

  // Set CAPPED=true in env to enable limits (for Vercel Hobby's 30s timeout constraint)
  const uncapped = process.env.CAPPED !== "true";

  const prData = JSON.stringify({
    title: pr.title,
    body: pr.body?.slice(0, uncapped ? undefined : 1000),
    state: pr.state,
    draft: pr.draft,
    merged_at: pr.merged_at,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    files: slim(uncapped ? files : cap(files, 20), ["filename", "status", "additions", "deletions"]),
    reviews: slim(uncapped ? reviews : cap(reviews, 10), ["user", "state", "body", "submitted_at"], uncapped ? undefined : 300),
    // in_reply_to_id lets Claude reconstruct threads
    review_comments: slim(uncapped ? reviewComments : cap(reviewComments, 20), ["id", "in_reply_to_id", "path", "user", "body", "created_at"], uncapped ? undefined : 300),
    issue_comments: slim(uncapped ? comments : cap(comments, 10), ["user", "body", "created_at"], uncapped ? undefined : 300),
  });

  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), 25_000);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: aiMaxTokens,
        messages: [
          {
            role: "user",
            content: `You are a Lead Software Engineer summarizing a GitHub PR to another engineer. This will be shared through Slack. Use Slack mrkdwn (*bold*, _italic_, • bullets) and be concise.

Before synthesising, explicitly map every review comment thread and issue comment:

For **inline review comments** ('/pulls/{pr_number}/comments'), group by 'in_reply_to_id' (or by 'path' + 'original_position') to reconstruct threads. For each thread record:
- **Topic** — what was being discussed (a line number, a design question, a naming concern, etc.)
- **Raised by** — the commenter who opened the thread
- **Resolution status** — one of:
  - 'Resolved' — thread was explicitly marked resolved, or the author confirmed the fix was made
  - 'Addressed' — a reply indicates the concern was acted on, but the thread was not formally resolved
  - 'Withdrawn' — the reviewer retracted the concern or said it was a nit/optional
  - 'Open' — no reply from the author, or the concern is still being debated
  - 'Merged open' — PR was merged with this thread still unresolved (flag this prominently)
- **Summary** — one to two sentences on what was raised, the main points of debate and what the outcome was.

For **issue-level comments** ('/issues/{pr_number}/comments'), summarise each distinct topic raised, main debate points and its current standing.

This thread map drives the Discussion Summary section. Do not skip it even if the PR has many comments — condense but cover all threads.

PR data (JSON):
${prData}

Write exactly 3 sections separated by a line containing only "---".
Do NOT include any text before the first section or after the last.

*Overview*
2–3 sentences explaining what this PR does and why. Write for a non-technical reader.

---

*Discussion Summary*
For each thread or topic: one or two lines with resolution status and summary of the main points of debate and decisions.
Format: - **[Topic]** _(raised by @user)_ — **[Resolved|Addressed|Withdrawn|Open|Merged open]** — summary, main points of debate and decisions.
End with 1–2 sentences on overall tone.

---

*What Changed*
1–2 sentences on the functional/behavioural change (non-technical).
Then bullet points of key technical changes grouped by area, with file names where helpful.`,
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(abortTimer);
    if (err.name === "AbortError") console.error("Claude API timed out");
    else console.error("Claude API fetch error:", err);
    return errorSection;
  }
  clearTimeout(abortTimer);

  if (!res.ok) {
    const err = await res.text();
    console.error("Claude API error:", err);
    return errorSection;
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text;
  if (!raw) return errorSection;

  return raw.split(/\n---\n/).map((chunk) => {
    const trimmed = chunk.trim();
    const titleMatch = trimmed.match(/^\*(.+?)\*/);
    const title = titleMatch ? titleMatch[1] : null;
    const text = title ? trimmed.slice(titleMatch[0].length).trim() : trimmed;
    return { title, text };
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function postToSlack(url, payload) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
