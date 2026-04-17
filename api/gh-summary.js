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
  const errorSection = [{ title: null, text: "_Could not generate AI summary._" }];

  // Trim large arrays to stay within token budget, keeping the most relevant fields
  const slim = (arr, fields) =>
    arr.map((o) => Object.fromEntries(fields.map((f) => [f, o[f]])));

  const prData = JSON.stringify({
    title: pr.title,
    body: pr.body,
    state: pr.state,
    draft: pr.draft,
    merged_at: pr.merged_at,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    files: slim(files, ["filename", "status", "additions", "deletions"]),
    reviews: slim(reviews, ["user", "state", "body", "submitted_at"]),
    // in_reply_to_id lets Claude reconstruct threads
    review_comments: slim(reviewComments, ["id", "in_reply_to_id", "path", "user", "body", "created_at"]),
    issue_comments: slim(comments, ["user", "body", "created_at"]),
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
      messages: [
        {
          role: "user",
          content: `You are summarizing a GitHub PR for a Slack message. Use Slack mrkdwn (*bold*, _italic_, • bullets). Be concise.


Before synthesising, explicitly map every review comment thread and issue comment:

For **inline review comments** ('/pulls/{pr_number}/comments'), group by 'in_reply_to_id' (or by 'path' + 'original_position') to reconstruct threads. For each thread record:
- **Topic** — what was being discussed (a line number, a design question, a naming concern, etc.)
- **Raised by** — the commenter who opened the thread
- **Resolution status** — one of:
  - 'Resolved' — thread was explicitly marked resolved, or the author confirmed the fix was made
  - 'Addressed' — a reply indicates the concern was acted on, but the thread was not formally resolved
  - 'Withdrawn'— the reviewer retracted the concern or said it was a nit/optional
  - 'Open' — no reply from the author, or the concern is still being debated
  - 'Merged open' — PR was merged with this thread still unresolved (flag this prominently)
- **Summary** — one sentence on what was raised and what the outcome was

For **issue-level comments** ('/issues/{pr_number}/comments'), summarise each distinct topic raised and its current standing.

Before writting, internally answer: **Discussion** — Were significant concerns raised? Contentious or smooth? Any unresolved or merged-open threads?

This thread map drives the Discussion Summary section. Do not skip it even if the PR has many comments — condense but cover all threads.

PR data (JSON — includes files, reviews, review_comments with in_reply_to_id for thread reconstruction, and issue_comments):
${prData}

[For each distinct thread or topic raised in reviews and comments, give a one-line entry with its resolution status. Format:

- **[Topic/concern]** _(raised by @reviewer)_ — **[Resolved | Addressed | Withdrawn | Open | Merged open]** — brief outcome
- ...

After the thread list, add 1–2 sentences on the overall tone: was review smooth or contentious? Were there any substantive design debates? If no meaningful discussion occurred, say so explicitly.]

Write exactly 3 sections separated by a line containing only "---".
Do NOT include any text before the first section or after the last.

*Overview*
2–3 sentences explaining what this PR does and why. Write for a non-technical reader.

---

*Discussion Summary*


---

*What Changed*
1–2 sentences on the functional/behavioural change (non-technical).
Then bullet points of key technical changes grouped by area, with file names where helpful.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Claude API error:", err);
    return errorSection;
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text;
  if (!raw) return errorSection;

  // Split on "---" section dividers and map to {title, text} objects
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
    ...summaryBlocks.map(({ title, text }) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: title ? `*${title}*\n${text}` : text,
      },
    })),
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
