/**
 * Lambda Adapter
 * Platform specifics: secret from Secrets Manager, async processing via self-invocation
 */

import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { gh, parsePRUrl } from "../clients/github.js";
import { summarizeWithClaude } from "../clients/anthropic.js";
import { postToSlack, postToSlackInChunks, fmtDate } from "../clients/slack.js";
import { getSecret, getEnvVar } from "../clients/secrets.js";
import { buildSlackBlocks } from "../blocks/summary.js";

export class LambdaAdapter {
  constructor() {
    this.lambdaClient = new LambdaClient({});
    this._initPromise = getSecret(process.env.SECRET_NAME || "gh-summary/secrets")
      .then((secrets) => {
        for (const [k, v] of Object.entries(secrets)) {
          if (process.env[k] === undefined) process.env[k] = v;
        }
      });
  }

  async getSlackSecret() {
    await this._initPromise;
    return getEnvVar("SLACK_SIGNING_SECRET");
  }

  async processPR(prUrl, responseUrl) {
    await this.lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: JSON.stringify({ isProcessingRequest: true, prUrl, responseUrl }),
    }));
  }

  async handleProcessingRequest(event) {
    await this._initPromise;
    const start = Date.now();
    console.log("handleProcessingRequest start", { prUrl: event.prUrl });
    try {
      await this._processPR(event.prUrl, event.responseUrl);
      console.log("handleProcessingRequest done", { elapsed: Date.now() - start });
    } catch (err) {
      console.error("processPR error:", err, { elapsed: Date.now() - start });
      await postToSlack(event.responseUrl, {
        response_type: "ephemeral",
        text: `❌ Unexpected error: ${err.message}`,
      });
    }
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
