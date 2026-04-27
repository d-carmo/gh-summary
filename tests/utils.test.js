import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  parsePRUrl,
  verifySlackSignature,
  fmtDate,
  splitIntoBlocks,
  formatCI,
  formatReviewers,
  buildSlackBlocks,
} from "../lib/utils.js";

// ── parsePRUrl ────────────────────────────────────────────────────────────────

describe("parsePRUrl", () => {
  it("parses a valid GitHub PR URL", () => {
    expect(parsePRUrl("https://github.com/owner/repo/pull/42")).toEqual({
      owner: "owner",
      repo: "repo",
      number: "42",
    });
  });

  it("parses a URL with a path prefix before github.com", () => {
    expect(parsePRUrl("https://github.com/org/my-repo/pull/1")).toEqual({
      owner: "org",
      repo: "my-repo",
      number: "1",
    });
  });

  it("throws on an invalid URL", () => {
    expect(() => parsePRUrl("https://example.com/not-a-pr")).toThrow(
      "Invalid GitHub PR URL"
    );
  });

  it("throws on a GitHub URL that is not a pull request", () => {
    expect(() => parsePRUrl("https://github.com/owner/repo/issues/1")).toThrow(
      "Invalid GitHub PR URL"
    );
  });
});

// ── verifySlackSignature ──────────────────────────────────────────────────────

const SECRET = "test-signing-secret";

function makeSlackHeaders(body, secret = SECRET, offsetSec = 0) {
  const ts = Math.floor(Date.now() / 1000) + offsetSec;
  const sig =
    "v0=" +
    crypto
      .createHmac("sha256", secret)
      .update(`v0:${ts}:${body}`)
      .digest("hex");
  return {
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": sig,
  };
}

describe("verifySlackSignature", () => {
  const body = "text=hello&response_url=https%3A%2F%2Fhooks.slack.com%2F";

  it("returns false when secret is empty", () => {
    expect(verifySlackSignature({}, body, "")).toBe(false);
  });

  it("returns false when secret is undefined", () => {
    expect(verifySlackSignature({}, body, undefined)).toBe(false);
  });

  it("returns false when timestamp header is missing", () => {
    expect(
      verifySlackSignature({ "x-slack-signature": "v0=abc" }, body, SECRET)
    ).toBe(false);
  });

  it("returns false when signature header is missing", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      verifySlackSignature(
        { "x-slack-request-timestamp": ts },
        body,
        SECRET
      )
    ).toBe(false);
  });

  it("returns false for a stale timestamp (> 5 min old)", () => {
    const staleTs = Math.floor(Date.now() / 1000) - 400;
    expect(
      verifySlackSignature(
        {
          "x-slack-request-timestamp": String(staleTs),
          "x-slack-signature": "v0=whatever",
        },
        body,
        SECRET
      )
    ).toBe(false);
  });

  it("returns false for a wrong signature (same length, different value)", () => {
    const headers = makeSlackHeaders(body);
    headers["x-slack-signature"] = "v0=" + "a".repeat(64);
    expect(verifySlackSignature(headers, body, SECRET)).toBe(false);
  });

  it("returns false when signature lengths differ", () => {
    const headers = makeSlackHeaders(body);
    headers["x-slack-signature"] = "v0=tooshort";
    expect(verifySlackSignature(headers, body, SECRET)).toBe(false);
  });

  it("returns true for a valid signature", () => {
    const headers = makeSlackHeaders(body);
    expect(verifySlackSignature(headers, body, SECRET)).toBe(true);
  });
});

// ── fmtDate ───────────────────────────────────────────────────────────────────

describe("fmtDate", () => {
  it("formats an ISO date string into a locale date", () => {
    const result = fmtDate("2024-01-05T00:00:00Z");
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/5/);
    expect(result).toMatch(/2024/);
  });
});

// ── splitIntoBlocks ───────────────────────────────────────────────────────────

describe("splitIntoBlocks", () => {
  it("returns a single section block for short text", () => {
    const blocks = splitIntoBlocks("hello world");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "hello world" },
    });
  });

  it("splits two long lines that together exceed the limit", () => {
    const line = "x".repeat(2000);
    const blocks = splitIntoBlocks(`${line}\n${line}`, 2900);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text.text).toBe(line);
    expect(blocks[1].text.text).toBe(line);
  });

  it("hard-splits a single line that exceeds the limit", () => {
    const text = "a".repeat(6000);
    const blocks = splitIntoBlocks(text, 2900);
    expect(blocks).toHaveLength(Math.ceil(6000 / 2900));
    blocks.forEach((b) => expect(b.text.text.length).toBeLessThanOrEqual(2900));
  });

  it("accumulates short lines without splitting", () => {
    const text = ["line1", "line2", "line3"].join("\n");
    expect(splitIntoBlocks(text, 2900)).toHaveLength(1);
  });

  it("starts a new chunk after a hard-split line", () => {
    const bigLine = "b".repeat(6000);
    const smallLine = "s".repeat(10);
    const blocks = splitIntoBlocks(`${bigLine}\n${smallLine}`, 2900);
    // big line → 3 hard-split blocks; small line → appended to new chunk
    const lastBlock = blocks.at(-1);
    expect(lastBlock.text.text).toBe(smallLine);
  });
});

// ── formatCI ──────────────────────────────────────────────────────────────────

describe("formatCI", () => {
  it("returns no-checks message for an empty array", () => {
    expect(formatCI([])).toBe("_No CI checks found_");
  });

  it("counts successes", () => {
    expect(formatCI([{ conclusion: "success", name: "build" }])).toContain(
      "1 passed"
    );
  });

  it("counts failures and lists their names", () => {
    const result = formatCI([
      { conclusion: "failure", name: "lint" },
      { conclusion: "timed_out", name: "e2e" },
    ]);
    expect(result).toContain("2 failed");
    expect(result).toContain("lint");
    expect(result).toContain("e2e");
    expect(result).toContain("*Failed checks:*");
  });

  it("counts skipped and neutral runs together", () => {
    const result = formatCI([
      { conclusion: "skipped", name: "a" },
      { conclusion: "neutral", name: "b" },
    ]);
    expect(result).toContain("2 skipped");
  });

  it("counts in-progress (null conclusion) as pending", () => {
    expect(formatCI([{ conclusion: null, name: "deploy" }])).toContain(
      "1 pending"
    );
  });

  it("omits the failed-checks line when there are no failures", () => {
    const result = formatCI([{ conclusion: "success", name: "ci" }]);
    expect(result).not.toContain("*Failed checks:*");
  });

  it("handles mixed results across all categories", () => {
    const runs = [
      { conclusion: "success", name: "unit" },
      { conclusion: "failure", name: "lint" },
      { conclusion: "skipped", name: "perf" },
      { conclusion: null, name: "deploy" },
    ];
    const result = formatCI(runs);
    expect(result).toContain("1 passed");
    expect(result).toContain("1 failed");
    expect(result).toContain("1 skipped");
    expect(result).toContain("1 pending");
  });
});

// ── formatReviewers ───────────────────────────────────────────────────────────

describe("formatReviewers", () => {
  it("returns null when requested_reviewers is empty", () => {
    expect(formatReviewers({ requested_reviewers: [] })).toBeNull();
  });

  it("returns null when requested_reviewers is absent", () => {
    expect(formatReviewers({})).toBeNull();
  });

  it("returns a formatted string for a single reviewer", () => {
    const result = formatReviewers({
      requested_reviewers: [{ login: "alice" }],
    });
    expect(result).toBe("alice _(requested)_");
  });

  it("joins multiple reviewers with the separator", () => {
    const result = formatReviewers({
      requested_reviewers: [{ login: "alice" }, { login: "bob" }],
    });
    expect(result).toContain("alice _(requested)_");
    expect(result).toContain("bob _(requested)_");
    expect(result).toContain("  ·  ");
  });
});

// ── buildSlackBlocks ──────────────────────────────────────────────────────────

const BASE_PR = {
  number: 42,
  title: "Test PR",
  state: "open",
  draft: false,
  merged_at: null,
  user: { login: "author" },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  html_url: "https://github.com/o/r/pull/42",
  additions: 10,
  deletions: 5,
  changed_files: 3,
  requested_reviewers: [],
};

const SUMMARY = [{ title: "Overview", text: "A change." }];

describe("buildSlackBlocks", () => {
  it('shows "✅ Merged" for a merged PR (merged_at takes priority over state)', () => {
    const pr = { ...BASE_PR, merged_at: "2024-01-03T00:00:00Z", state: "closed" };
    const blocks = buildSlackBlocks(pr, [], SUMMARY);
    expect(blocks[1].fields[0].text).toContain("✅ Merged");
  });

  it('shows "🔴 Closed" for a closed but unmerged PR', () => {
    const blocks = buildSlackBlocks({ ...BASE_PR, state: "closed" }, [], SUMMARY);
    expect(blocks[1].fields[0].text).toContain("🔴 Closed");
  });

  it('shows "🚧 Draft" for a draft PR', () => {
    const blocks = buildSlackBlocks({ ...BASE_PR, draft: true }, [], SUMMARY);
    expect(blocks[1].fields[0].text).toContain("🚧 Draft");
  });

  it('shows "🟢 Open" for an open PR', () => {
    const blocks = buildSlackBlocks(BASE_PR, [], SUMMARY);
    expect(blocks[1].fields[0].text).toContain("🟢 Open");
  });

  it("truncates the PR title to 140 characters in the header", () => {
    const pr = { ...BASE_PR, title: "x".repeat(200) };
    const blocks = buildSlackBlocks(pr, [], SUMMARY);
    const headerText = blocks[0].text.text;
    // "PR #42: " prefix + 140 chars of title
    expect(headerText).toHaveLength("PR #42: ".length + 140);
  });

  it("uses singular 'file' when changed_files is 1", () => {
    const blocks = buildSlackBlocks({ ...BASE_PR, changed_files: 1 }, [], SUMMARY);
    expect(blocks[1].fields[5].text).toContain("1 file");
    expect(blocks[1].fields[5].text).not.toContain("1 files");
  });

  it("uses plural 'files' when changed_files > 1", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], SUMMARY);
    expect(blocks[1].fields[5].text).toContain("3 files");
  });

  it("shows merged date in the Merged field", () => {
    const pr = { ...BASE_PR, merged_at: "2024-03-15T00:00:00Z", state: "closed" };
    const blocks = buildSlackBlocks(pr, [], SUMMARY);
    const mergedField = blocks[1].fields[4].text;
    expect(mergedField).toContain("Mar");
  });

  it("shows '—' in the Merged field for unmerged PRs", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], SUMMARY);
    expect(blocks[1].fields[4].text).toContain("—");
  });

  it("includes a Reviewers section when requested_reviewers is non-empty", () => {
    const pr = {
      ...BASE_PR,
      requested_reviewers: [{ login: "reviewer1" }],
    };
    const blocks = buildSlackBlocks(pr, [], SUMMARY);
    expect(blocks.some((b) => b.text?.text?.includes("Reviewers"))).toBe(true);
  });

  it("omits the Reviewers section when there are no requested reviewers", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], SUMMARY);
    expect(blocks.some((b) => b.text?.text?.includes("Reviewers"))).toBe(false);
  });

  it("renders a summary block that has a title", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], [{ title: "Overview", text: "Details." }]);
    expect(blocks.some((b) => b.text?.text?.includes("*Overview*"))).toBe(true);
  });

  it("renders a summary block that has no title", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], [{ title: null, text: "Plain text." }]);
    expect(blocks.some((b) => b.text?.text === "Plain text.")).toBe(true);
  });

  it("includes CI status from check runs", () => {
    const runs = [{ conclusion: "success", name: "build" }];
    const blocks = buildSlackBlocks(BASE_PR, runs, SUMMARY);
    const ciBlock = blocks.find((b) => b.text?.text?.includes("CI Status"));
    expect(ciBlock.text.text).toContain("1 passed");
  });

  it("includes an Open PR button with the correct URL", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], SUMMARY);
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions.elements[0].url).toBe(BASE_PR.html_url);
  });

  it("includes a context block with a timestamp", () => {
    const blocks = buildSlackBlocks(BASE_PR, [], SUMMARY);
    const context = blocks.find((b) => b.type === "context");
    expect(context.elements[0].text).toContain("gh-summary bot");
  });
});
