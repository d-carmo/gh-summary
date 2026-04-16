# gh-summary — Slack PR Summary Bot

A Slack slash command that fetches a GitHub PR's metadata, CI status, and discussion thread, then produces an AI-powered summary using Claude.

```
/gh-summary https://github.com/owner/repo/pull/42
```

---

## Architecture

```
User (Slack)
    │  /gh-summary <PR URL>
    ▼
Slack Platform ──────────────────────────────────────────────┐
    │  HTTP POST (signed)                                    │
    ▼                                                        │
Vercel Serverless Function  (api/gh-summary.js)              │
    │  1. Verify Slack signature (HMAC-SHA256)               │
    │  2. Respond HTTP 200 immediately  ─────────────────────┘
    │  3. Async: fetch data + summarize        ← acknowledgement
    │
    ├──► GitHub REST API  (parallel)
    │       • GET /pulls/:number              (PR metadata)
    │       • GET /issues/:number/comments    (discussion)
    │       • GET /pulls/:number/reviews      (code reviews)
    │       • GET /pulls/:number/comments     (review comments)
    │       • GET /pulls/:number/files        (changed files)
    │
    ├──► GitHub REST API  (sequential — needs PR head SHA)
    │       • GET /commits/:sha/check-runs    (CI status)
    │
    └──► Anthropic Messages API  (after all GitHub data is ready)
            • claude-sonnet-4-6 (discussion → structured summary)
                │
                ▼
         POST response_url → Slack (formatted Block Kit message)
```

> Full diagram: [docs/architecture.svg](./docs/architecture.svg)

### Why a server at all?

Slack slash commands work by POSTing to **your** URL. There is no way to point a slash command directly at GitHub or any other third-party API — Slack needs an endpoint it can reach that can verify the request, hold your credentials, and format the response.

Vercel's free Hobby tier is sufficient; this function typically runs in under 5 seconds.

---

## What the Bot Returns

Each `/gh-summary` invocation posts a message with:

| Section | Details |
|---|---|
| **Header** | PR number and title |
| **Metadata** | Status, author, created/updated/merged dates, diff size |
| **Reviewers** | Who has been requested to review |
| **CI Status** | Pass/fail/pending counts, names of failing checks |
| **Discussion Summary** | AI-generated bullet points covering debates, decisions, open questions, and agreed strategies |
| **Link** | One-click button to open the PR |

---

## Prerequisites

| Requirement | Where to get it |
|---|---|
| Node.js ≥ 18 | [nodejs.org](https://nodejs.org) |
| Vercel account (free) | [vercel.com](https://vercel.com) |
| Slack workspace (admin) | Your workspace settings |
| GitHub account | [github.com/settings/tokens](https://github.com/settings/tokens) |
| Anthropic account | [console.anthropic.com](https://console.anthropic.com) |

---

## Setup Guide

### Step 1 — Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it `gh-summary`, choose your workspace
3. Under **Slash Commands** → **Create New Command**:
   - Command: `/gh-summary`
   - Request URL: *(fill in after Step 3)*
   - Short description: `Summarize a GitHub PR`
   - Usage hint: `https://github.com/owner/repo/pull/123`
4. Under **OAuth & Permissions** → **Scopes** → **Bot Token Scopes** → add `chat:write`
5. Click **Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`)
6. Under **Basic Information** → copy the **Signing Secret**

### Step 2 — Get a GitHub Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens) → **Generate new token (classic)**
2. Name it `gh-summary-bot`
3. Select scopes:
   - `public_repo` — for public repositories only
   - `repo` — if you need access to private repositories
4. Click **Generate token** and copy it

### Step 3 — Get an Anthropic API Key

1. Go to [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. Click **Create Key**, name it `gh-summary`
3. Copy the key (`sk-ant-…`)

### Step 4 — Deploy to Vercel

```bash
# Clone / enter the project
cd gh-summary

# Install Vercel CLI
npm install

# Log in to Vercel
npx vercel login

# Deploy (follow prompts — accept all defaults)
npx vercel deploy --prod
```

Copy the deployment URL, e.g. `https://gh-summary-xxx.vercel.app`

### Step 5 — Set Environment Variables

In the Vercel dashboard → your project → **Settings** → **Environment Variables**, add:

| Variable | Value |
|---|---|
| `SLACK_SIGNING_SECRET` | From Step 1 |
| `SLACK_BOT_TOKEN` | From Step 1 |
| `GITHUB_TOKEN` | From Step 2 |
| `ANTHROPIC_API_KEY` | From Step 3 |

Or via CLI:

```bash
npx vercel env add SLACK_SIGNING_SECRET
npx vercel env add SLACK_BOT_TOKEN
npx vercel env add GITHUB_TOKEN
npx vercel env add ANTHROPIC_API_KEY

# Redeploy to apply env vars
npx vercel deploy --prod
```

### Step 6 — Wire Up Slack

1. Go back to your Slack App → **Slash Commands** → edit `/gh-summary`
2. Set Request URL to: `https://your-project.vercel.app/api/gh-summary`
3. Save

### Step 7 — Test It

In any Slack channel:

```
/gh-summary https://github.com/vercel/next.js/pull/1
```

---

## Local Development

```bash
# Copy env file and fill in your values
cp .env.example .env

# Start local Vercel dev server
npm run dev
# → Listening at http://localhost:3000

# In another terminal, run the smoke test
node scripts/test-local.js https://github.com/owner/repo/pull/123
```

The test script generates a valid Slack HMAC signature so the local function accepts it.

---

## Security

- **Signature verification** — every request is validated with HMAC-SHA256 against your `SLACK_SIGNING_SECRET`. Forged or replayed requests are rejected.
- **Replay protection** — requests older than 5 minutes are rejected.
- **No credential storage** — API keys live only in Vercel's encrypted environment variables, never in code.
- **GitHub token scope** — use `public_repo` unless you need private repo access.

---

## Cost Estimate

| Service | Usage | Cost |
|---|---|---|
| Vercel | ~1s function, hobby tier | **Free** |
| GitHub API | 4 requests/invocation | **Free** (5000 req/hr limit) |
| Anthropic | ~800 input + 600 output tokens | ~$0.003 per summary |

---

## Troubleshooting

**Bot doesn't respond**
- Check Vercel function logs: `npx vercel logs`
- Ensure all 4 env vars are set and you redeployed after adding them

**"Unauthorized" error**
- `SLACK_SIGNING_SECRET` is wrong or missing

**GitHub 404 error**
- For private repos, ensure your token has the `repo` scope (not just `public_repo`)

**"Could not generate AI summary"**
- Check your `ANTHROPIC_API_KEY` is valid and has credits

**Slack says "operation_timeout"**
- The function took > 3s to acknowledge. This shouldn't happen — if it does, check Vercel cold start times or upgrade to Vercel Pro for reserved functions.

---

## File Structure

```
gh-summary/
├── api/
│   └── gh-summary.js     # The entire bot (~200 lines)
├── docs/
│   ├── README.md         # This file
│   └── architecture.svg  # System diagram
├── scripts/
│   └── test-local.js     # Local smoke test
├── .env.example          # Environment variable template
├── .gitignore
├── package.json
└── vercel.json           # Vercel configuration
```

---

## Extending the Bot

Some ideas if you want to go further:

- **Inline code review comments** — fetch `/pulls/:number/comments` (review comments on specific lines) and include them in the Claude prompt
- **PR labels / milestones** — already in the PR API response, just add them to the Block Kit blocks
- **`/gh-summary-team` command** — list all open PRs for a repo needing review
- **Caching** — store summaries in Vercel KV to avoid re-fetching unchanged PRs
- **Webhooks** — instead of slash commands, trigger summaries automatically when a PR is opened or merged
