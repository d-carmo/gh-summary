/**
 * Block Kit Metadata Builders
 * Formats PR metadata, CI status, and reviewer info into Slack blocks
 */
import { fmtDate } from "../clients/slack.js";

/**
 * Build header block for PR summary
 */
export function buildHeaderBlock(pr) {
  return {
    type: "header",
    text: {
      type: "plain_text",
      text: `PR #${pr.number}: ${pr.title.slice(0, 140)}`,
      emoji: true,
    },
  };
}

/**
 * Build metadata fields block (status, author, dates, diff)
 */
export function buildMetadataBlock(pr) {
  const status = pr.merged_at
    ? "✅ Merged"
    : pr.state === "closed"
    ? "🔴 Closed"
    : pr.draft
    ? "🚧 Draft"
    : "🟢 Open";

  return {
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
  };
}

/**
 * Format CI check runs into Slack-friendly string
 */
export function formatCI(runs) {
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
    else counts.pending; // null = in_progress
  }

  let out = `✅ ${counts.success} passed  ❌ ${counts.failure} failed  ⏳ ${counts.pending} pending  ⏭ ${counts.skipped} skipped`;
  if (failed.length) out += `\n*Failed checks:* ${failed.join(", ")}`;
  return out;
}

/**
 * Format requested reviewers for Slack display
 */
export function formatReviewers(pr) {
  const requested = (pr.requested_reviewers || []).map(
    (r) => `${r.login} _(requested)_`
  );
  if (!requested.length) return null;
  return requested.join("  ·  ");
}

/**
 * Build reviewer info block
 */
export function buildReviewersBlock(pr) {
  const reviewers = formatReviewers(pr);
  if (!reviewers) return [];
  
  return [{
    type: "section",
    text: { type: "mrkdwn", text: `*Reviewers*\n${reviewers}` },
  }];
}

/**
 * Build CI status block
 */
export function buildCIBlock(checkRuns) {
  const ci = formatCI(checkRuns);
  return {
    type: "section",
    text: { type: "mrkdwn", text: `*CI Status*\n${ci}` },
  };
}

/**
 * Build divider block
 */
export function buildDividerBlock() {
  return { type: "divider" };
}
