---
name: github-pr-summary
description: >
  Generate a structured, handover-ready summary document for a GitHub Pull Request.
  Use this skill whenever the user provides a GitHub PR URL, PR number + repo, or asks
  to summarize, document, or create a report from a pull request. Covers goal/intent,
  status, discussion summary, and a layered change overview (high-level first, technical
  details after). Ideal for stakeholder handovers, audits, async reviews, and release notes.
  Supports private repos via gh CLI auth or a GITHUB_TOKEN. Trigger even for casual
  phrasing like "can you summarise this PR", "write up this PR for the team", or
  "I need to share what this PR does with a non-technical person".
---

# GitHub PR Summary Skill

Produce a clear, layered PR summary document suitable for handover to a third party
(internal stakeholder, auditor, external partner). The document leads with human-readable
context and progressively discloses technical detail.

---

## Step 1 — Choose Fetch Method & Check Auth

**Preferred method: `gh api` (GitHub CLI)**
This gives structured JSON, handles auth transparently, and works for private repos.
Fallback: direct HTTPS API calls with a token, or `web_fetch` for public repos only.

### 1a — Determine which method to use

Run this check first:

```bash
gh auth status 2>&1
```

| Result | Action |
|--------|--------|
| `Logged in to github.com` | ✅ Use `gh api` — proceed to Step 2 |
| `not logged in` / command not found | Check for `GITHUB_TOKEN` env var (Step 1b) |

### 1b — Fallback: GITHUB_TOKEN

If `gh` is not available or not authenticated, check for a token:

```bash
echo $GITHUB_TOKEN
```

- **Token present** → use direct HTTPS API calls with `Authorization: Bearer $GITHUB_TOKEN` header (see Step 2b)
- **No token** → the PR must be **public**. Use `web_fetch` on the GitHub REST API URL (see Step 2c). Warn the user that private repos will fail and suggest one of:
  - Run `gh auth login` to authenticate the CLI
  - Set `GITHUB_TOKEN` with a Personal Access Token (PAT) that has `repo` scope

### 1c — Parse the PR reference

From the user's input, extract `{owner}`, `{repo}`, and `{pr_number}`:
- From a URL: `https://github.com/{owner}/{repo}/pull/{pr_number}`
- From shorthand: "PR #42 in acme/backend" → owner=`acme`, repo=`backend`, number=`42`

---

## Step 2 — Fetch PR Data

Fetch all of the following. Run commands in parallel where possible.

### 2a — Using `gh api` (preferred)

```bash
# Core PR metadata
gh api repos/{owner}/{repo}/pulls/{pr_number}

# Reviews and inline review comments
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments

# General discussion comments
gh api repos/{owner}/{repo}/issues/{pr_number}/comments

# Changed files
gh api repos/{owner}/{repo}/pulls/{pr_number}/files

# CI check runs (get SHA from PR first)
gh api repos/{owner}/{repo}/commits/$(gh api repos/{owner}/{repo}/pulls/{pr_number} --jq '.head.sha')/check-runs
```

Useful `--jq` filter to pull just what you need from the PR:
```bash
gh api repos/{owner}/{repo}/pulls/{pr_number} \
  --jq '{title, body, state, draft, merged, merged_at,
         user: .user.login,
         reviewers: [.requested_reviewers[].login],
         labels: [.labels[].name],
         milestone: .milestone.title,
         additions, deletions, changed_files}'
```

### 2b — Using GITHUB_TOKEN (no gh CLI)

Replace each `gh api repos/{owner}/{repo}/...` call with:

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
  https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}

# Same pattern for /reviews, /comments, /files, /check-runs
```

### 2c — Public repo fallback (web_fetch only)

Use `web_fetch` on the REST API endpoints — no auth header needed for public repos:
- `https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}`
- `https://api.github.com/repos/{owner}/{repo}/pulls/{pr_number}/files`
- `https://api.github.com/repos/{owner}/{repo}/issues/{pr_number}/comments`

Note in the output document that this was fetched without authentication.

---

## Step 3 — Key Data to Extract

From the fetched JSON, collect:

- **Title** and **body** (PR description)
- **Author** (`user.login`), **assignees**, **requested reviewers**
- **Labels**, **milestone**, linked issues (look for `closes #N` / `fixes #N` in body)
- **State**: `open` / `closed` / `merged` (`merged: true`), and whether it is a `draft`
- **Merge date** (`merged_at`), **base branch** and **head branch**
- **Diff stats**: `additions`, `deletions`, `changed_files`
- **File list**: filename, status (added/modified/removed/renamed), additions/deletions per file
- **Reviews**: reviewer login, state (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`), body
- **Comments**: author, body — scan for decisions, concerns, back-and-forth
- **CI checks**: name, status, conclusion (success / failure / neutral)

---

## Step 4 — Map Discussion Threads (mandatory)

Before synthesising, explicitly map every review comment thread and issue comment:

For **inline review comments** (`/pulls/{pr_number}/comments`), group by `in_reply_to_id` (or by `path` + `original_position`) to reconstruct threads. For each thread record:
- **Topic** — what was being discussed (a line number, a design question, a naming concern, etc.)
- **Raised by** — the commenter who opened the thread
- **Resolution status** — one of:
  - `Resolved` — thread was explicitly marked resolved, or the author confirmed the fix was made
  - `Addressed` — a reply indicates the concern was acted on, but the thread was not formally resolved
  - `Withdrawn` — the reviewer retracted the concern or said it was a nit/optional
  - `Open` — no reply from the author, or the concern is still being debated
  - `Merged open` — PR was merged with this thread still unresolved (flag this prominently)
- **Summary** — one sentence on what was raised and what the outcome was

For **issue-level comments** (`/issues/{pr_number}/comments`), summarise each distinct topic raised and its current standing.

This thread map drives the Discussion Summary section. Do not skip it even if the PR has many comments — condense but cover all threads.

---

## Step 5 — Analyse & Synthesise

Before writing, internally answer:

1. **Goal** — What problem does this PR solve? What feature does it add? What is being fixed?
2. **Status** — Merged, open, or closed without merging? CI passing? All reviews approved?
3. **Discussion** — Were significant concerns raised? Contentious or smooth? Any unresolved or merged-open threads?
4. **Changes** — What changed at a product/behaviour level? Then at a code/architecture level?

---

## Step 6 — Write the Document

Write in clear, professional prose. Avoid jargon in the upper sections; save technical specifics for the lower sections.

### Document Structure

```
# PR Summary: {PR Title}

**Repository:** {owner/repo}
**PR:** #{number} — {URL}
**Author:** {author}
**Status:** {Open | Merged | Closed} {(merged on DATE | closed on DATE)}
**Reviewers:** {list with approval state, e.g. "@alice ✅ @bob 🔄"}
**Labels / Milestone:** {if any}
**Fetched via:** {gh api (authenticated as @user) | GITHUB_TOKEN | public API (unauthenticated)}

---

## Overview

[2–4 sentences. What is this PR about and why does it exist? Write for someone who
has no context on the codebase. Focus on the "what" and "why", not the "how".]

---

## Status & Health

[Current state (open/merged/closed), CI check summary (passing/failing/pending),
review approval status, any blocking issues or unresolved threads, overall readiness.]

---

## Discussion Summary

[For each distinct thread or topic raised in reviews and comments, give a one-line entry with its resolution status. Format:

- **[Topic/concern]** _(raised by @reviewer)_ — **[Resolved | Addressed | Withdrawn | Open | Merged open]** — brief outcome
- ...

After the thread list, add 1–2 sentences on the overall tone: was review smooth or contentious? Were there any substantive design debates? If no meaningful discussion occurred, say so explicitly.]

---

## What Changed — Overview

[Non-technical summary of the functional/behavioural changes. What does the system
do differently after this PR? What does a user or operator experience differently?
Bullet points are fine for multiple distinct changes.]

---

## What Changed — Technical Detail

### Files & Scope
- **X files changed** — +Y lines added, −Z lines removed
- Primary areas touched: [e.g. authentication module, database migrations, API endpoints]

### Key Changes by Area

[Group files/changes logically by module, layer, or concern.]

**{Area / Module}**
[1–3 sentences describing what was changed and why, specific enough for a developer
to understand without reading the diff.]

### Dependencies & Config Changes
[New/removed packages, env variable changes, config file changes, migration
requirements. Omit this section if none.]

### Risks & Considerations
[Breaking changes, migration steps, performance implications, security notes,
rollback considerations. If none: "No known risks identified."]

---

*Summary generated {DATE}*
*Data source: {gh api authenticated as @{username} | GITHUB_TOKEN | unauthenticated public API}*
```

---

## Step 7 — Format & Tone Notes

- **Upper half** (Overview → Discussion): readable by a PM, client, or exec. No code snippets, no file paths, plain English.
- **Lower half** (Technical Detail): suitable for a developer. Can include file names, function names, concise code references — but explanatory, not a raw diff dump.
- Keep the document under ~600 words unless the PR is genuinely large.
- If the PR is a draft/WIP, note this prominently in Status & Health.
- If the PR description is empty or sparse, infer intent from the diff and comments — and note this in the document.

---

## Output

Write the document as clean Markdown. If the user wants a downloadable file, offer to produce a `.md` or `.docx` file using the available file-creation tools.

---

## Auth Quick Reference

If you need to guide the user through setting up auth, use this:

**Option A — GitHub CLI (recommended):**
```bash
gh auth login
# Follow the prompts; select GitHub.com, HTTPS, browser auth
# Verify with: gh auth status
```

**Option B — Personal Access Token:**
```bash
export GITHUB_TOKEN=ghp_yourTokenHere
# Token needs: repo scope (for private repos), read:org (for org repos)
# Create at: https://github.com/settings/tokens
# For fine-grained tokens: grant Read access to Pull Requests and Metadata
```
