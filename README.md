# gh-summary — Slack PR Summary Bot
> [!WARNING]
> This is a simple POC. The code hasn't been audited and there are no warranties it will be suitable for produciton environments.

A Slack slash command that fetches a GitHub PR's metadata, CI status, and discussion thread, then produces an AI-powered summary using Claude.

(I've also included a skill with the same goal - you can find it under ./skills).

For another in this series of integration, have a look at [The Coroner](https://github.com/d-carmo/the_coroner) - a tool to generate post-mortems from a slack channel. 

```
/gh-summary https://github.com/owner/repo/pull/42
```


---

## Contents

- [Architecture](#architecture)
- [What the Bot Returns](#what-the-bot-returns)
- [Prerequisites](#prerequisites)
- [Setup Guide](#setup-guide)
- [Local Development](#local-development)
- [Security](#security)
- [Cost Estimate](#cost-estimate)
- [Troubleshooting](#troubleshooting)
- [File Structure](#file-structure)
- [Known limitations](#known-limitations)
- [Extending the Bot](#extending-the-bot)

---

## Architecture

```
User (Slack)
    │  /gh-summary <PR URL>
    ▼
Slack Platform ──────────────────────────────────────────────┐
    │  HTTP POST (signed)                                    │
    ▼                                                        │
Provider Adapter Layer                                       │
    ├──► Vercel: waitUntil() keeps function alive             │
    └──► AWS Lambda: Fire-and-forget (CloudWatch logs)        │
    │                                                          │
    ▼                                                          │
Core Business Logic (src/)                                   │
    ├──► src/clients/github.js   — GitHub API client          │
    ├──► src/clients/anthropic.js — Claude AI summarization   │
    ├──► src/clients/slack.js     — Signature verification    │
    ├──► src/blocks/metadata.js   — CI, reviewers, metadata    │
    └──► src/blocks/summary.js    — Text splitting             │
    │                                                          │
    ├──► GitHub REST API  (parallel)                          │
    │       • GET /pulls/:number              (PR metadata)   │
    │       • GET /issues/:number/comments    (discussion)    │
    │       • GET /pulls/:number/reviews      (code reviews)  │
    │       • GET /pulls/:number/comments     (review comments)│
    │       • GET /pulls/:number/files        (changed files) │
    │                                                          │
    ├──► GitHub REST API  (sequential — needs PR head SHA)    │
    │       • GET /commits/:sha/check-runs    (CI status)     │
    │                                                          │
    └──► Anthropic Messages API  (after all GitHub data is ready)
            • claude-sonnet-4-6 (discussion → structured summary)
                │
                ▼
         POST response_url → Slack (formatted Block Kit message)
```

### Why a server at all?

Slack slash commands work by POSTing to **your** URL. There is no way to point a slash command directly at GitHub or any other third-party API — Slack needs an endpoint it can reach that can verify the request, hold your credentials, and format the response.

Choose your provider:
- **Vercel Hobby (free)** — ~1s function time, simplest setup
- **AWS Lambda** — Pay-per-use, scales with traffic, no cold start limits

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
| Vercel account (free) **or** AWS account | [vercel.com](https://vercel.com) / [aws.amazon.com](https://aws.amazon.com) |
| Slack workspace (admin) | Your workspace settings |
| GitHub account | [github.com/settings/tokens](https://github.com/settings/tokens) |
| Anthropic account | [console.anthropic.com](https://console.anthropic.com) |

### Choosing a Provider

**Vercel** — simplest, free tier sufficient for most use cases.  
**AWS Lambda** — pay-per-use, better for high-traffic or cost-sensitive deployments.

See the **Deployment Options** section below for setup instructions.

---

## Deployment Options

### Option 1: Deploy to Vercel (Recommended for most users)

```bash
# Clone / enter the project
cd gh-summary

# Install dependencies
npm install

# Log in to Vercel
npx vercel login

# Deploy (follow prompts — accept all defaults)
npx vercel deploy --prod
```

Copy the deployment URL, e.g. `https://gh-summary-xxx.vercel.app`

### Option 2: Deploy to AWS Lambda + API Gateway

1. **Install SAM CLI**: [docs.aws.amazon.com/sam/latest/cli/installation.html](https://docs.aws.amazon.com/sam/latest/cli/installation.html)
   
   ```bash
   pip install aws-sam-cli
   sam --version
   ```

2. **Create secrets in AWS Secrets Manager**:
   
   ```bash
   aws secretsmanager create-secret \
     --name gh-summary/secrets \
     --secret-string '{
       "SLACK_SIGNING_SECRET": "your-slack-signing-secret",
       "GITHUB_TOKEN": "your-github-token",
       "ANTHROPIC_API_KEY": "your-anthropic-api-key"
     }'
   ```

3. **Deploy with SAM**:
   
   ```bash
   sam build
   sam deploy \
     --stack-name gh-summary-stack \
     --template-file aws/sam-template.yaml \
     --capabilities CAPABILITY_IAM
   ```

4. **Get your API Gateway URL** from the deployment output, e.g.:
   
   ```
   https://abcdefgh123.execute-api.us-east-1.amazonaws.com/prod/gh-summary
   ```

### Step 5 — Set Environment Variables (Vercel Only)

In your Vercel project dashboard, add:

| Variable | Value |
|---|---|
| `SLACK_SIGNING_SECRET` | From Slack App settings |
| `GITHUB_TOKEN` | From GitHub token generator |
| `ANTHROPIC_API_KEY` | From Anthropic console |
| `PROVIDER` | `vercel` (default) |
| `CAPPED` | _(optional)_ Set to `true` on Vercel Hobby for timeout safety |
| `MAX_TOKENS` | _(optional)_ Max tokens for Claude's response. Defaults to `1000` |

Or via CLI (Vercel):

```bash
npx vercel env add SLACK_SIGNING_SECRET
npx vercel env add GITHUB_TOKEN
npx vercel env add ANTHROPIC_API_KEY
npx vercel env add PROVIDER
npx vercel env add CAPPED
npx vercel env add MAX_TOKENS

# Redeploy to apply env vars
npx vercel deploy --prod
```

### Step 6 — Wire Up Slack

1. Go back to your Slack App → **Slash Commands** → edit `/gh-summary`
2. Set Request URL to: `https://your-project.vercel.app/api/gh-summary` (Vercel) or `https://your-api-gateway-url/api/gh-summary` (AWS)
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

# Start local Vercel dev server (or use Lambda locally with SAM)
npm run dev
# → Listening at http://localhost:3000

# Or test with AWS SAM locally
sam local invoke GhSummaryFunction --event event.json
```

The test script generates a valid Slack HMAC signature so the local function accepts it.

---

## Security

- **Signature verification** — every request is validated with HMAC-SHA256 against your `SLACK_SIGNING_SECRET`. Forged or replayed requests are rejected.
- **Replay protection** — requests older than 5 minutes are rejected.
- **No credential storage** — API keys live only in environment variables (Vercel encrypted env vars or AWS Lambda config), never in code.
- **GitHub token scope** — use `public_repo` unless you need private repo access.

---

## Cost Estimate

| Service | Vercel Hobby | AWS Lambda (estimated) |
|---|---|---|
| **Hosting** | Free | ~$0.20/month at 100 summaries/day |
| **GitHub API** | Free | Free (5000 req/hr limit) |
| **Anthropic AI** | ~$0.003/summary | Same (~$0.003/summary) |

*AWS Lambda pricing: $0.400 per 1M requests + $0.0000166667 per GB-second compute.*

---

## Troubleshooting

**Bot doesn't respond**
- Check provider logs: `npx vercel logs` (Vercel) or AWS CloudWatch Logs (Lambda)
- Ensure all 4 env vars are set and you redeployed after adding them

**"Unauthorized" error**
- `SLACK_SIGNING_SECRET` is wrong or missing

**GitHub 404 error**
- For private repos, ensure your token has the `repo` scope (not just `public_repo`)

**"Could not generate AI summary"**
- Check your `ANTHROPIC_API_KEY` is valid and has credits

**Slack says "operation_timeout"**
- The function took > 3s to acknowledge. This shouldn't happen — if it does, check provider cold start times or upgrade plan (Vercel Pro) / increase timeout (Lambda).

**AWS Lambda-specific**
- Check CloudWatch Logs for error messages
- Ensure API Gateway is properly configured with CORS headers

---

## File Structure

```
gh-summary/
├── api/
│   └── gh-summary.js          # Entry point (uses adapter pattern)
├── src/                        # Provider-agnostic core logic
│   ├── adapters/              # Platform-specific implementations
│   │   ├── index.js           # Factory function (createAdapter)
│   │   ├── vercel.js          # Vercel adapter with waitUntil()
│   │   └── lambda.js          # AWS Lambda adapter (fire-and-forget)
│   ├── clients/               # API integrations
│   │   ├── github.js          # GitHub REST client + URL parsing
│   │   ├── anthropic.js       # Claude AI summarization logic
│   │   └── slack.js           # Signature verification helpers
│   └── blocks/                # Block Kit builders
│       ├── metadata.js        # CI status, reviewers, PR metadata
│       └── summary.js         # Text splitting into Slack blocks
├── docs/
│   ├── README.md              # This file
│   └── architecture.svg       # System diagram
├── scripts/
│   └── test-local.js          # Local smoke test
├── aws/                       # AWS deployment (optional)
│   ├── sam-template.yaml      # SAM template for Lambda + API Gateway
│   └── lambda-function.zip    # Deployed function bundle
├── .env.example               # Environment variable template (includes PROVIDER)
├── .gitignore
├── package.json
└── vercel.json                # Vercel configuration
```

---

## Deployment Options Summary

| Feature | Vercel | AWS Lambda |
|---|---|---|
| **Setup complexity** | ⭐ Simplest | ⭐⭐ Moderate |
| **Cost (low traffic)** | Free | ~$0.20/month |
| **Cold starts** | < 1s typical | 1-3s first request |
| **Timeout handling** | `waitUntil()` built-in | Fire-and-forget |
| **Switching providers** | Change `.env` only | Change `.env` only |

The modular architecture means adding a new provider (GCP, n8n, etc.) is as simple as:
1. Creating `src/adapters/gcp.js` implementing the same interface
2. Registering it in `src/adapters/index.js`  
3. Setting `PROVIDER=gcp` in `.env`

Done! 🎉

---

## Known limitations

- **Vercel Hobby timeout** — Vercel Hobby has a 30s max function duration. For large PRs, Claude can take longer than that, causing the response to never reach Slack. Set `CAPPED=true` to enforce input limits and stay within the 30s timeout (Free tier friendly). On paid plans or AWS Lambda, omit `CAPPED` (or set it to `false`) to send full data.
- **AWS Lambda cold starts** — First request after deployment may take 1-3 seconds due to initialization. Subsequent requests are faster (< 200ms typically).

---

## Extending the Bot

Some ideas if you want to go further:

- **PR labels / milestones** — already in the PR API response, just add them to the Block Kit blocks

- **Support for Vercel alternatives** - Adding support for n8n or lambda functions, ideally in a modularized way

### Adding a New Provider (e.g., GCP, n8n)

The modular architecture makes this straightforward:

1. Create `src/adapters/gcp.js` implementing the same interface as `vercel.js` and `lambda.js`:
   ```js
   export class GCPAdapter {
     async acknowledge(responseUrl, payload) { /* ... */ }
     async processPR(prUrl, responseUrl) { /* fire-and-forget */ }
     async postToSlack(responseUrl, payload) { /* ... */ }
   }
   ```

2. Register it in `src/adapters/index.js`:
   ```js
   export function createAdapter(provider) {
     if (provider === 'gcp') return new GCPAdapter();
     // ... existing providers
   }
   ```

3. Set `PROVIDER=gcp` in your `.env` file and redeploy.

That's it! The core business logic (`src/clients/`) remains unchanged.

