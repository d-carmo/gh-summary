/**
 * Vercel Adapter
 * Platform specifics: secret from env, async processing via waitUntil
 */

import { waitUntil } from "@vercel/functions";
import { gh, parsePRUrl } from "../clients/github.js";
import { summarizeWithClaude } from "../clients/anthropic.js";
import { postToSlack, postToSlackInChunks } from "../clients/slack.js";
import { buildSlackBlocks } from "../blocks/summary.js";

export class VercelAdapter {
  getSlackSecret() {
    return process.env.SLACK_SIGNING_SECRET;
  }

  processPR(prUrl, responseUrl) {
    waitUntil(
      this._processPR(prUrl, responseUrl).catch((err) => {
        console.error("processPR error:", err);
        postToSlack(responseUrl, {
          response_type: "ephemeral",
          text: `❌ Unexpected error: ${err.message}`,
        });
      })
    );
  }

  async _processPR(prUrl, responseUrl) {
    const { owner, repo, number } = parsePRUrl(prUrl);

    const [pr, comments, reviews, reviewComments, files] = await Promise.all([
      gh(`/repos/${owner}/${repo}/pulls/${number}`),
      gh(`/repos/${owner}/${repo}/issues/${number}/comments`),
      gh(`/repos/${owner}/${repo}/pulls/${number}/reviews`),
      gh(`/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`),
      gh(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100`),
    ]);

    const ciData = await gh(
      `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`
    );

    const summarySections = await summarizeWithClaude(pr, files, comments, reviews, reviewComments);

    const blocks = buildSlackBlocks(pr, ciData.check_runs ?? [], summarySections);
    console.log("Total blocks to send:", blocks.length);

    await postToSlackInChunks(responseUrl, { response_type: "in_channel", blocks });
  }
}
