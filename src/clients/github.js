/**
 * GitHub API Client
 * Provider-agnostic HTTP client for GitHub REST API
 */

const RETRIES = 3;
const USER_AGENT = "gh-summary-slack-bot/1.0";
const ACCEPT_HEADER = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/**
 * Parse PR URL to extract owner, repo, and number
 */
export function parsePRUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) throw new Error("Invalid GitHub PR URL");
  return { owner: match[1], repo: match[2], number: match[3] };
}

/**
 * Fetch from GitHub API with retry logic
 */
export async function gh(path, token = process.env.GITHUB_TOKEN) {
  const url = `https://api.github.com${path}`;
  
  const opts = {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: ACCEPT_HEADER,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": USER_AGENT,
    },
  };

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, opts);
      
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub API ${res.status} on ${path}: ${body}`);
      }
      
      return res.json();
    } catch (err) {
      // Retry on network errors with exponential backoff
      if (
        err.cause?.code === "ECONNRESET" || 
        err.cause?.code === "ECONNREFUSED"
      ) {
        if (attempt < RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
      }
      throw err;
    }
  }
}
