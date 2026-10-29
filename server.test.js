"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  validateUrl, isPublicAddress, fetchPublic, parseRobots, robotsAllows,
  parseHtml, appendLimitedChunk, createServer, ResearchError
} = require("./server");

test("accepts standard public website URLs and rejects unsafe URL forms", () => {
  assert.equal(validateUrl("https://example.com/services#contact").href, "https://example.com/services");
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/", "http://example.com:8080/"]) {
    assert.throws(() => validateUrl(value), ResearchError, value);
  }
  for (const value of ["http://localhost/", "http://127.0.0.1/", "http://10.0.0.2/", "http://169.254.1.2/", "http://[::1]/"]) {
    assert.throws(() => validateUrl(value), ResearchError, value);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("192.168.1.1"), false);
});

test("blocks a redirect to a prohibited destination before fetching it", async () => {
  let calls = 0;
  await assert.rejects(fetchPublic("https://example.com/", {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnce: async () => {
      calls += 1;
      return { status: 302, location: "http://127.0.0.1/admin", headers: {}, body: Buffer.alloc(0) };
    }
  }), (error) => error instanceof ResearchError && error.code === "unsafe_redirect");
  assert.equal(calls, 1);
});

test("robot rules disallow matching paths and allow unrelated ones", () => {
  const rules = "User-agent: *\nDisallow: /private\nAllow: /private/public\n";
  assert.equal(robotsAllows(rules, "https://example.com/private/"), false);
  assert.equal(robotsAllows(rules, "https://example.com/private/public/page"), true);
  assert.equal(robotsAllows("User-agent: OtherBot\nDisallow: /\n", "https://example.com/"), true);
});

test("parses basic evidence while excluding scripts and styles", () => {
  const result = parseHtml(`<!doctype html><html><head><title>North &amp; Shore</title>
    <meta name="description" content="Local service &amp; repairs"></head><body>
    <script>document.body.innerHTML = '<h1>fake</h1>';</script><style>.x{color:red}</style>
    <h1>Trusted heading</h1><p>We provide dependable plumbing repairs across the north side of town for homes and local businesses.</p>
    <li>Emergency callouts available every day of the week.</li></body></html>`);
  assert.equal(result.title, "North & Shore");
  assert.equal(result.metaDescription, "Local service & repairs");
  assert.deepEqual(result.headings, ["Trusted heading"]);
  assert.equal(result.excerpts.length, 2);
  assert.ok(!JSON.stringify(result).includes("fake"));
});

test("enforces the response byte limit and classifies timeout failures", async () => {
  const chunks = [];
  assert.equal(appendLimitedChunk(chunks, 0, Buffer.from("1234"), 4), 4);
  assert.throws(() => appendLimitedChunk(chunks, 4, Buffer.from("5"), 4), (error) => error instanceof ResearchError && error.status === 413);
  await assert.rejects(fetchPublic("https://example.com/", {
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnce: async () => { throw new ResearchError(504, "The website took too long to respond.", "timeout"); }
  }), (error) => error instanceof ResearchError && error.status === 504);
});

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await callback(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("endpoint returns success, empty-content, blocked-site, and timeout states", async () => {
  let result = { sourceUrl: "https://example.com/", title: "Example", metaDescription: "", headings: [], excerpts: [], empty: false };
  await withServer(async () => result, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/research-homepage`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "null" }, body: JSON.stringify({ url: "https://example.com/" })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).title, "Example");
  });
  result = { sourceUrl: "https://example.com/", title: "", metaDescription: "", headings: [], excerpts: [], empty: true };
  await withServer(async () => result, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/research-homepage`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "null" }, body: JSON.stringify({ url: "https://example.com/" })
    });
    assert.equal((await response.json()).empty, true);
  });
  for (const [status, text] of [[403, "robots.txt"], [504, "too long"]]) {
    await withServer(async () => { throw new ResearchError(status, text, "test_failure"); }, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/research-homepage`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "null" }, body: JSON.stringify({ url: "https://example.com/" })
      });
      assert.equal(response.status, status);
      assert.match((await response.json()).error, new RegExp(text));
    });
  }
});

test("endpoint enforces request-size and per-minute request limits", async () => {
  await withServer(async () => { throw new ResearchError(400, "Invalid URL.", "invalid_url"); }, async (port) => {
    const large = await fetch(`http://127.0.0.1:${port}/api/research-homepage`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "null" }, body: "x".repeat(9000)
    });
    assert.equal(large.status, 413);
    let last;
    for (let index = 0; index < 21; index += 1) {
      last = await fetch(`http://127.0.0.1:${port}/api/research-homepage`, {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "null" }, body: "{}"
      });
      await last.arrayBuffer();
    }
    assert.equal(last.status, 429);
  });
});
