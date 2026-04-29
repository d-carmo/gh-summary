/**
 * Anthropic AI Client
 * Handles Claude API calls for PR summarization
 */

const UNCAPPED_TIMEOUT_MS = 300_000;
const CAPPED_TIMEOUT_MS = 26_000;
const DEFAULT_MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 4096;

/**
 * Cap data to stay within Vercel Hobby timeout limits when CAPPED=true
 */
function isCapped() {
  return process.env.CAPPED === "true";
}

const cap = (arr, n) => (arr.length > n ? arr.slice(-n) : arr);

/**
 * Truncate body field to limit token usage
 */
function truncateBody(obj, limit = 500) {
  return obj.body 
    ? { ...obj, body: obj.body.slice(0, limit) } 
    : obj;
}

/**
 * Slim down large arrays for AI context window
 */
function slim(arr, fields, bodyLimit) {
  return arr.map((o) => {
    const picked = Object.fromEntries(fields.map((f) => [f, o[f]]));
    return bodyLimit ? truncateBody(picked, bodyLimit) : picked;
  });
}

/**
 * Build AI context payload from PR data
 */
function buildAiContext(pr, files, comments, reviews, reviewComments) {
  const prData = JSON.stringify({
    title: pr.title,
    body: pr.body?.slice(0, !isCapped() ? undefined: 1000),
    state: pr.state,
    draft: pr.draft,
    merged_at: pr.merged_at,
    additions: pr.additions,
    deletions: pr.deletions,
    changed_files: pr.changed_files,
    files: slim(!isCapped() ? files : cap(files, 20), ["filename", "status", "additions", "deletions"]),
    reviews: slim(!isCapped() ? reviews : cap(reviews, 10), ["user", "state", "body", "submitted_at"], isCapped() ? undefined : 300),
    review_comments: slim(
      !isCapped() ? reviewComments : cap(reviewComments, 20), 
      ["id", "in_reply_to_id", "path", "user", "body", "created_at"], 
      !isCapped() ? undefined : 300
    ),
    issue_comments: slim(
      !isCapped() ? comments : cap(comments, 10), 
      ["user", "body", "created_at"], 
      !isCapped() ? undefined : 300
    ),
  });

  return `You are a Lead Software Engineer summarizing a GitHub PR to another engineer. This will be shared through Slack. Use Slack mrkdwn (*bold*, _italic_, • bullets) and be concise.

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
Then bullet points of key technical changes grouped by area, with file names where helpful.`;
}

/**
 * Call Anthropic Claude API to generate PR summary
 */
export async function summarizeWithClaude(pr, files, comments, reviews, reviewComments) {
  const aiMaxTokens = DEFAULT_MAX_TOKENS;
  const errorSection = [{ title: null, text: "_Could not generate AI summary._" }];

  const abort = new AbortController();
  const abortTimer = setTimeout(() => abort.abort(), isCapped()? CAPPED_TIMEOUT_MS : UNCAPPED_TIMEOUT_MS);

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
        messages: [{
          role: "user",
          content: buildAiContext(pr, files, comments, reviews, reviewComments),
        }],
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

  // Parse the AI response into structured sections
  return raw.split(/\n---\n/).map((chunk) => {
    const trimmed = chunk.trim();
    const titleMatch = trimmed.match(/^\*(.+?)\*/);
    const title = titleMatch ? titleMatch[1] : null;
    const text = title ? trimmed.slice(titleMatch[0].length).trim() : trimmed;
    return { title, text };
  });
}
