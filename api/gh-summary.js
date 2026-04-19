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

import crypto from "crypto";
import { waitUntil } from "@vercel/functions";

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

function parsePRUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error("Invalid GitHub PR URL");
  return { owner: match[1], repo: match[2], number: match[3] };
}

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
  const aiMaxTokens = 1200;
  const errorSection = [{ title: null, text: "_Could not generate AI summary._" }];

  const slim = (arr, fields) =>
    arr.map((o) => Object.fromEntries(fields.map((f) => [f, o[f]])));

  const cap = (arr, n) => (arr.length > n ? arr.slice(-n) : arr);

  const MAX_CHARS = 12_000;
  let prData = JSON.stringify({
    title: pr.title,
    body: pr.body?.slice(0, 1000),
    state: pr.state,
    draft: pr.draft,
    merged_at: pr.merged_at,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    files: slim(cap(files, 30), ["filename", "status", "additions", "deletions"]),
    reviews: slim(cap(reviews, 20), ["user", "state", "body", "submitted_at"]),
    // in_reply_to_id lets Claude reconstruct threads
    review_comments: slim(cap(reviewComments, 40), ["id", "in_reply_to_id", "path", "user", "body", "created_at"]),
    issue_comments: slim(cap(comments, 20), ["user", "body", "created_at"]),
  });
  if (prData.length > MAX_CHARS) prData = prData.slice(0, MAX_CHARS);

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
For each thread or topic: one line with resolution status.
Format: - **[Topic]** _(raised by @user)_ — **[Resolved|Addressed|Withdrawn|Open|Merged open]** — summary.
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

// ── Slack Block Kit ───────────────────────────────────────────────────────────

function buildSlackBlocks(pr, checkRuns, summaryBlocks) {
  const status = pr.merged_at
    ? "✅ Merged"
    : pr.state === "closed"
    ? "🔴 Closed"
    : pr.draft
    ? "🚧 Draft"
    : "🟢 Open";

  const ci = formatCI(checkRuns);
  const reviewSummary = formatReviewers(pr);

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `PR #${pr.number}: ${pr.title.slice(0, 140)}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Status*\n${status}` },
        { type: "mrkdwn", text: `*Author*\n${pr.user.login}` },
        { type: "mrkdwn", text: `*Created*\n${fmtDate(pr.created_at)}` },
        { type: "mrkdwn", text: `*Last Updated*\n${fmtDate(pr.updated_at)}` },
        {
          type: "mrkdwn",
          text: `*Merged*\n${pr.merged_at ? fmtDate(pr.merged_at) : "—"}`,
        },
        {
          type: "mrkdwn",
          text: `*Diff*\n+${pr.additions} / -${pr.deletions} across ${pr.changed_files} file${pr.changed_files !== 1 ? "s" : ""}`,
        },
      ],
    },
    ...(reviewSummary
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Reviewers*\n${reviewSummary}` },
          },
        ]
      : []),
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*CI Status*\n${ci}` },
    },
    { type: "divider" },
    ...summaryBlocks.flatMap(({ title, text }) =>
      splitIntoBlocks(title ? `*${title}*\n${text}` : text)
    ),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open PR →", emoji: true },
          url: pr.html_url,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_Summary generated by gh-summary bot · ${new Date().toUTCString()}_`,
        },
      ],
    },
  ];
}

function formatCI(runs) {
  if (!runs.length) return "_No CI checks found_";

  const counts = { success: 0, failure: 0, pending: 0, skipped: 0 };
  const failed = [];

  for (const run of runs) {
    const c = run.conclusion;
    if (c === "success") counts.success++;
    else if (c === "failure" || c === "timed_out") {
      counts.failure++;
      failed.push(run.name);
    } else if (c === "skipped" || c === "neutral") counts.skipped++;
    else counts.pending++; // null = in_progress
  }

  let out = `✅ ${counts.success} passed  ❌ ${counts.failure} failed  ⏳ ${counts.pending} pending  ⏭ ${counts.skipped} skipped`;
  if (failed.length) out += `\n*Failed checks:* ${failed.join(", ")}`;
  return out;
}

function formatReviewers(pr) {
  const requested = (pr.requested_reviewers || []).map(
    (r) => `${r.login} _(requested)_`
  );
  if (!requested.length) return null;
  return requested.join("  ·  ");
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function splitIntoBlocks(text, limit = 2900) {
  const blocks = [];
  const lines = text.split("\n");
  let chunk = "";

  for (const line of lines) {
    const candidate = chunk ? `${chunk}\n${line}` : line;
    if (candidate.length > limit) {
      if (chunk) blocks.push(chunk);
      // A single line longer than limit must be hard-split
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          blocks.push(line.slice(i, i + limit));
        }
        chunk = "";
      } else {
        chunk = line;
      }
    } else {
      chunk = candidate;
    }
  }
  if (chunk) blocks.push(chunk);

  return blocks.map((t) => ({ type: "section", text: { type: "mrkdwn", text: t } }));
}

async function postToSlack(url, payload) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
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

function verifySlackSignature(headers, rawBody, secret) {
  if (!secret) return false;
  const timestamp = headers["x-slack-request-timestamp"];
  const slackSig = headers["x-slack-signature"];
  if (!timestamp || !slackSig) return false;

  // Reject requests older than 5 minutes (replay attack protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const sigBase = `v0:${timestamp}:${rawBody}`;
  const computed =
    "v0=" +
    crypto.createHmac("sha256", secret).update(sigBase).digest("hex");

  if (computed.length !== slackSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig));
}
