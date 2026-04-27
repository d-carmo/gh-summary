import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { EventEmitter } from "events";

// Hoist before the module import so @vercel/functions is mocked at load time
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn((p) => p) }));

import handler from "../api/gh-summary.js";
import { waitUntil } from "@vercel/functions";

// ── Test helpers ──────────────────────────────────────────────────────────────

const SECRET = "test-signing-secret";

function signedHeaders(body, offsetSec = 0) {
  const ts = Math.floor(Date.now() / 1000) + offsetSec;
  const sig =
    "v0=" +
    crypto
      .createHmac("sha256", SECRET)
      .update(`v0:${ts}:${body}`)
      .digest("hex");
  return {
    "x-slack-request-timestamp": String(ts),
    "x-slack-signature": sig,
  };
}

function makeReq({ method = "POST", body = "", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  process.nextTick(() => {
    req.emit("data", body);
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = (c) => {
    res._status = c;
    return res;
  };
  res.json = (b) => {
    res._body = b;
    return res;
  };
  res.send = (b) => {
    res._body = b;
    return res;
  };
  return res;
}

// Minimal PR fixture matching what GitHub API returns
const PR = {
  head: { sha: "abc123" },
  number: 42,
  title: "Test PR",
  state: "open",
  draft: false,
  merged_at: null,
  user: { login: "author" },
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  html_url: "https://github.com/o/r/pull/42",
  additions: 5,
  deletions: 2,
  changed_files: 1,
  requested_reviewers: [],
};

function ghOk(data) {
  return {
    ok: true,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

// Build a fetch mock that covers the full happy-path pipeline:
//   5× GitHub (PR, comments, reviews, review-comments, files)
//   1× GitHub CI check-runs
//   1× Anthropic
//   1× Slack response_url POST
function fullPipelineFetch(claudeText = "*Overview*\nA change.\n---\nNo discussion.\n---\nFile tweaks.") {
  return vi.fn()
    .mockResolvedValueOnce(ghOk(PR))
    .mockResolvedValueOnce(ghOk([]))
    .mockResolvedValueOnce(ghOk([]))
    .mockResolvedValueOnce(ghOk([]))
    .mockResolvedValueOnce(ghOk([]))
    .mockResolvedValueOnce(ghOk({ check_runs: [] }))
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ content: [{ text: claudeText }] }),
    })
    .mockResolvedValueOnce({ ok: true });
}

// Await the promise that was passed to waitUntil (the processPR chain)
async function awaitProcessPR() {
  const calls = waitUntil.mock.calls;
  if (calls.length > 0) {
    await calls.at(-1)[0];
  }
}

const VALID_BODY =
  "text=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F42" +
  "&response_url=https%3A%2F%2Fhooks.slack.com%2Fresponse" +
  "&user_name=testuser";

// ── handler: method guard ─────────────────────────────────────────────────────

describe("handler — GET request", () => {
  it("returns 200 with health-check text", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    expect(res._body).toContain("running");
  });
});

// ── handler: signature verification ──────────────────────────────────────────

describe("handler — signature verification", () => {
  beforeEach(() => vi.stubEnv("SLACK_SIGNING_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("returns 401 when the Slack signature is invalid", async () => {
    const body = "text=hello";
    const req = makeReq({
      body,
      headers: {
        "x-slack-request-timestamp": "0",
        "x-slack-signature": "v0=bad",
      },
    });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Unauthorized" });
  });
});

// ── handler: URL validation ───────────────────────────────────────────────────

describe("handler — URL validation", () => {
  beforeEach(() => vi.stubEnv("SLACK_SIGNING_SECRET", SECRET));
  afterEach(() => vi.unstubAllEnvs());

  it("returns a usage hint when text is missing", async () => {
    const body = "response_url=https%3A%2F%2Fhooks.slack.com%2F";
    const req = makeReq({ body, headers: signedHeaders(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res._body.text).toContain("❌ Usage:");
  });

  it("returns a usage hint when the URL is not a GitHub URL", async () => {
    const body =
      "text=https%3A%2F%2Fexample.com%2Ffoo&response_url=https%3A%2F%2Fhooks.slack.com%2F";
    const req = makeReq({ body, headers: signedHeaders(body) });
    const res = makeRes();
    await handler(req, res);
    expect(res._body.text).toContain("❌ Usage:");
    expect(res._body.response_type).toBe("ephemeral");
  });
});

// ── handler: happy path ───────────────────────────────────────────────────────

describe("handler — valid request", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("acknowledges the request immediately with the caller's username", async () => {
    vi.stubGlobal("fetch", fullPipelineFetch());
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    const res = makeRes();
    await handler(req, res);
    await awaitProcessPR();
    expect(res._body.text).toContain("@testuser");
    expect(res._body.response_type).toBe("ephemeral");
  });

  it("defaults to '@there' when user_name is absent", async () => {
    const body =
      "text=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F42" +
      "&response_url=https%3A%2F%2Fhooks.slack.com%2Fresponse";
    vi.stubGlobal("fetch", fullPipelineFetch());
    const req = makeReq({ body, headers: signedHeaders(body) });
    const res = makeRes();
    await handler(req, res);
    await awaitProcessPR();
    expect(res._body.text).toContain("@there");
  });

  it("calls waitUntil to keep the function alive", async () => {
    vi.stubGlobal("fetch", fullPipelineFetch());
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("fires all 8 fetch calls in the happy path (5 GH + 1 CI + 1 Claude + 1 Slack)", async () => {
    const fetchMock = fullPipelineFetch();
    vi.stubGlobal("fetch", fetchMock);
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("posts an in_channel Slack message with blocks on success", async () => {
    vi.stubGlobal("fetch", fullPipelineFetch());
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    const [slackUrl, slackOpts] = fetch.mock.calls.at(-1);
    expect(slackUrl).toContain("hooks.slack.com");
    const payload = JSON.parse(slackOpts.body);
    expect(payload.response_type).toBe("in_channel");
    expect(Array.isArray(payload.blocks)).toBe(true);
  });
});

// ── processPR — error recovery ────────────────────────────────────────────────

describe("handler — processPR error recovery", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("posts an error message to Slack when processPR throws", async () => {
    const responseUrl = "https://hooks.slack.com/response";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        // All GitHub calls fail
        return Promise.reject(new Error("GitHub down"));
      })
    );
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();

    const slackCalls = fetch.mock.calls.filter(([url]) =>
      url.includes("hooks.slack.com")
    );
    expect(slackCalls.length).toBeGreaterThan(0);
    const payload = JSON.parse(slackCalls.at(-1)[1].body);
    expect(payload.text).toContain("❌");
  });
});

// ── getRawBody — stream error ─────────────────────────────────────────────────

describe("getRawBody — stream error propagates to handler", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects when the request stream emits an error", async () => {
    const req = new EventEmitter();
    req.method = "POST";
    req.headers = {};
    const streamError = new Error("stream broken");
    process.nextTick(() => req.emit("error", streamError));
    const res = makeRes();
    await expect(handler(req, res)).rejects.toThrow("stream broken");
  });
});

// ── gh — HTTP error (no retry) ────────────────────────────────────────────────

describe("gh — HTTP error handling", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("throws immediately on a non-2xx GitHub response without retrying", async () => {
    let prEndpointHits = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        // Count how many times the exact PR endpoint is called
        if (url === "https://api.github.com/repos/o/r/pulls/42") prEndpointHits++;
        return Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve("Not Found"),
        });
      })
    );
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    // gh() must not retry HTTP errors — the PR endpoint should be called exactly once
    expect(prEndpointHits).toBe(1);
  });
});

// ── gh — ECONNRESET retry ─────────────────────────────────────────────────────

describe("gh — network retry", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it(
    "retries on ECONNRESET and succeeds on the next attempt",
    async () => {
      // The PR call (first of 5 parallel) will ECONNRESET once, then succeed.
      // Remaining calls succeed immediately.
      const networkErr = new Error("connection reset");
      networkErr.cause = { code: "ECONNRESET" };

      let prCallCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url) => {
          if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
          if (url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files")) {
            prCallCount++;
            if (prCallCount === 1) return Promise.reject(networkErr);
            return Promise.resolve(ghOk(PR));
          }
          if (url.includes("check-runs"))
            return Promise.resolve(ghOk({ check_runs: [] }));
          if (url.includes("api.anthropic.com"))
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  content: [{ text: "*Overview*\nDone." }],
                }),
            });
          return Promise.resolve(ghOk([]));
        })
      );

      const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
      await handler(req, makeRes());
      await awaitProcessPR();
      expect(prCallCount).toBe(2);
    },
    5000 // 500 ms backoff + margin
  );
});

// ── summarizeWithClaude — error paths ────────────────────────────────────────

function ghOnlyFetch(claudeOverride) {
  return vi.fn().mockImplementation((url) => {
    if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
    if (url.includes("api.anthropic.com")) return claudeOverride(url);
    if (url.includes("check-runs"))
      return Promise.resolve(ghOk({ check_runs: [] }));
    return Promise.resolve(ghOk(url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files") ? PR : []));
  });
}

describe("summarizeWithClaude — error paths", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("falls back to error section when fetch throws an AbortError", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        if (url.includes("api.anthropic.com")) return Promise.reject(abortErr);
        if (url.includes("check-runs"))
          return Promise.resolve(ghOk({ check_runs: [] }));
        return Promise.resolve(ghOk(url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files") ? PR : []));
      })
    );
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    const [, opts] = fetch.mock.calls.find(([u]) => u.includes("hooks.slack.com/response"));
    const payload = JSON.parse(opts.body);
    const allText = JSON.stringify(payload.blocks);
    expect(allText).toContain("Could not generate AI summary");
  });

  it("falls back to error section on a generic Claude fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        if (url.includes("api.anthropic.com"))
          return Promise.reject(new Error("network down"));
        if (url.includes("check-runs"))
          return Promise.resolve(ghOk({ check_runs: [] }));
        return Promise.resolve(ghOk(url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files") ? PR : []));
      })
    );
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    const [, opts] = fetch.mock.calls.find(([u]) => u.includes("hooks.slack.com/response"));
    const payload = JSON.parse(opts.body);
    expect(JSON.stringify(payload.blocks)).toContain("Could not generate AI summary");
  });

  it("falls back to error section when the Claude API returns a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        if (url.includes("api.anthropic.com"))
          return Promise.resolve({
            ok: false,
            text: () => Promise.resolve("rate limited"),
          });
        if (url.includes("check-runs"))
          return Promise.resolve(ghOk({ check_runs: [] }));
        return Promise.resolve(ghOk(url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files") ? PR : []));
      })
    );
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    const [, opts] = fetch.mock.calls.find(([u]) => u.includes("hooks.slack.com/response"));
    const payload = JSON.parse(opts.body);
    expect(JSON.stringify(payload.blocks)).toContain("Could not generate AI summary");
  });

  it("falls back to error section when Claude returns empty content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        if (url.includes("api.anthropic.com"))
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ content: [] }),
          });
        if (url.includes("check-runs"))
          return Promise.resolve(ghOk({ check_runs: [] }));
        return Promise.resolve(ghOk(url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files") ? PR : []));
      })
    );
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();
    const [, opts] = fetch.mock.calls.find(([u]) => u.includes("hooks.slack.com/response"));
    const payload = JSON.parse(opts.body);
    expect(JSON.stringify(payload.blocks)).toContain("Could not generate AI summary");
  });
});

// ── summarizeWithClaude — CAPPED mode ────────────────────────────────────────

describe("summarizeWithClaude — CAPPED mode", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("CAPPED", "true");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("succeeds with CAPPED=true and arrays that exceed cap limits", async () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => ({
      filename: `file${i}.js`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));
    const manyReviews = Array.from({ length: 15 }, (_, i) => ({
      user: { login: `u${i}` },
      state: "COMMENTED",
      body: "x".repeat(400), // triggers truncateBody
      submitted_at: "2024-01-01T00:00:00Z",
    }));
    const prWithBody = { ...PR, body: "x".repeat(1500) };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url) => {
        if (url.includes("hooks.slack.com")) return Promise.resolve({ ok: true });
        if (url.includes("api.anthropic.com"))
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                content: [{ text: "*Overview*\nCapped.\n---\n*Discussion*\nNone.\n---\n*Changes*\nMinor." }],
              }),
          });
        if (url.includes("check-runs"))
          return Promise.resolve(ghOk({ check_runs: [] }));
        if (url.includes("/reviews") && !url.includes("comments"))
          return Promise.resolve(ghOk(manyReviews));
        if (url.includes("/files"))
          return Promise.resolve(ghOk(manyFiles));
        if (url.includes("/pulls/42") && !url.includes("comments") && !url.includes("reviews") && !url.includes("files"))
          return Promise.resolve(ghOk(prWithBody));
        return Promise.resolve(ghOk([]));
      })
    );

    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();

    // The pipeline should complete and post blocks to Slack
    const slackCall = fetch.mock.calls.find(([u]) => u.includes("hooks.slack.com/response"));
    expect(slackCall).toBeDefined();
    const payload = JSON.parse(slackCall[1].body);
    expect(payload.response_type).toBe("in_channel");
  });
});

// ── summarizeWithClaude — section parsing ────────────────────────────────────

describe("summarizeWithClaude — section parsing", () => {
  beforeEach(() => {
    vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
    vi.stubEnv("GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("renders titled and untitled sections from Claude response", async () => {
    const claudeText = "*Overview*\nSome overview.\n---\nUntitled section here.";
    vi.stubGlobal("fetch", fullPipelineFetch(claudeText));
    const req = makeReq({ body: VALID_BODY, headers: signedHeaders(VALID_BODY) });
    await handler(req, makeRes());
    await awaitProcessPR();

    const [, opts] = fetch.mock.calls.find(([u]) => u.includes("hooks.slack.com/response"));
    const allText = JSON.stringify(JSON.parse(opts.body).blocks);
    expect(allText).toContain("Overview");
    expect(allText).toContain("Untitled section here.");
  });
});
