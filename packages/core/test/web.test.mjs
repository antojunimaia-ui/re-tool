import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  ToolError,
  normalizeUrl,
  parseHtml,
  parseRobotsTxt,
  robotsAllows,
  extractWebFindings,
  detectFrameworks,
  analyzeWeb,
  maskSecret,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

test("normalizeUrl adds https and strips the fragment", () => {
  assert.equal(normalizeUrl("example.com/a#frag").href, "https://example.com/a");
  assert.equal(normalizeUrl("http://example.com").href, "http://example.com/");
});

test("normalizeUrl rejects empty input and unsupported protocols", () => {
  assert.throws(() => normalizeUrl("   "), ToolError);
  assert.throws(() => normalizeUrl("ftp://example.com"), /Unsupported protocol/);
});

// ---------------------------------------------------------------------------
// HTML discovery
// ---------------------------------------------------------------------------

test("parseHtml extracts title, meta, scripts, inline scripts and links", () => {
  const html = `<!doctype html><html><head>
    <base href="/static/" />
    <title> Demo &amp; Co </title>
    <meta property="og:description" content="hello" />
    <meta name="generator" content="Next.js" />
    <script defer src="/app.js"></script>
    <script>'use strict';</script>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="modulepreload" href="/chunk.js" />
  </head></html>`;

  const parsed = parseHtml(html, "https://site.test/page");
  assert.equal(parsed.title, "Demo & Co");
  assert.equal(parsed.baseUrl, "https://site.test/static/");
  assert.equal(parsed.meta["generator"], "Next.js");
  assert.equal(parsed.meta["og:description"], "hello");
  assert.equal(parsed.scripts.length, 2);
  assert.equal(parsed.scripts[0].src, "/app.js");
  assert.equal(parsed.scripts[1].src, null);
  assert.match(parsed.scripts[1].inline, /use strict/);
  assert.equal(parsed.links.length, 2);
  assert.equal(parsed.links[1].rel, "modulepreload");
});

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

test("robotsAllows uses the longest matching rule and prefers Allow on ties", () => {
  const robots = parseRobotsTxt(`
    # comment
    User-agent: *
    Disallow: /private
    Allow: /private/ok
    Disallow: /tmp/*/secret
    User-agent: other-bot
    Disallow: /
  `);

  assert.equal(robotsAllows(robots, "/private", "re-tool").allowed, false);
  assert.equal(robotsAllows(robots, "/private/ok", "re-tool").allowed, true);
  assert.equal(robotsAllows(robots, "/tmp/a/secret", "re-tool").allowed, false);
  assert.equal(robotsAllows(robots, "/public", "re-tool").allowed, true);
  assert.equal(robotsAllows(robots, "/private/y", "re-tool").allowed, false);
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

test("extractWebFindings finds endpoints, routes, keys and flags (and drops noise)", () => {
  const strings = [
    { value: "https://api.site.test/v1/users", line: 1 },
    { value: "wss://socket.site.test/ws", line: 2 },
    { value: "/api/v1/orders", line: 3 },
    { value: "/dashboard", line: 4 },
    { value: "/users/:id", line: 5 },
    { value: "/static/logo.png", line: 6 },
    { value: "https://www.w3.org/2000/svg", line: 7 },
    { value: "https://react.dev/errors/418", line: 8 },
    { value: "pk_test_1234567890abcdefghij", line: 9 },
    { value: `AIza${"a".repeat(35)}`, line: 10 },
    {
      value:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      line: 11,
    },
    { value: "FEATURE_NEW_UI", line: 12 },
    { value: "enableBetaCheckout", line: 13 },
  ];

  const found = extractWebFindings([{ path: "app.js", strings }]);

  const endpointValues = found.endpoints.map((e) => e.value);
  assert.ok(endpointValues.includes("https://api.site.test/v1/users"));
  assert.ok(endpointValues.includes("wss://socket.site.test/ws"));
  assert.ok(endpointValues.includes("/api/v1/orders"));
  assert.ok(!endpointValues.includes("https://www.w3.org/2000/svg"));
  assert.ok(!endpointValues.includes("https://react.dev/errors/418"));
  assert.equal(found.endpoints.find((e) => e.value.endsWith("/ws"))?.kind, "ws");

  const routePaths = found.routes.map((r) => r.path);
  assert.ok(routePaths.includes("/dashboard"));
  assert.ok(routePaths.includes("/users/:id"));
  assert.ok(!routePaths.includes("/static/logo.png"));
  assert.ok(!routePaths.includes("/api/v1/orders"));

  const kinds = found.keys.map((k) => k.kind).sort();
  assert.deepEqual(kinds, ["google-api-key", "jwt", "publishable-key"]);

  const flags = found.featureFlags.map((f) => f.name).sort();
  assert.deepEqual(flags, ["FEATURE_NEW_UI", "enableBetaCheckout"]);

  assert.equal(found.endpoints[0].source, "app.js");
  assert.equal(typeof found.endpoints[0].line, "number");
});

test("extractWebFindings counts duplicates and respects the endpoint cap", () => {
  const strings = [
    { value: "/api/a", line: 1 },
    { value: "/api/a", line: 2 },
    { value: "/api/b", line: 3 },
  ];
  const found = extractWebFindings([{ path: "b.js", strings }], { maxEndpoints: 1 });
  assert.equal(found.endpoints.length, 1);
  assert.equal(found.endpoints[0].value, "/api/a");
  assert.equal(found.endpoints[0].count, 2);
});

test("detectFrameworks identifies React, Next.js and analytics", () => {
  const found = detectFrameworks({
    html: '<div id="__NEXT_DATA__"></div>',
    scripts: [
      "window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {};",
      "gtag('config', 'G-1'); googletagmanager.com/gtag",
    ],
    urls: ["https://site.test/_next/static/chunks/main.js"],
  });
  const names = found.map((f) => f.name);
  assert.ok(names.includes("React"));
  assert.ok(names.includes("Next.js"));
  assert.ok(names.includes("Google Analytics"));
  assert.equal(found.find((f) => f.name === "React")?.confidence, "high");
});

test("maskSecret keeps a short prefix and suffix", () => {
  assert.equal(maskSecret("pk_test_1234567890abcdefghij"), "pk_tes\u2026ghij");
  assert.equal(maskSecret("short"), "shor\u2026");
});

// ---------------------------------------------------------------------------
// End-to-end against a local server
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html>
  <head>
    <base href="/static/" />
    <title>Acme Shop</title>
    <meta name="generator" content="Next.js" />
    <meta name="description" content="demo page" />
    <script src="/app.js"></script>
    <script>
      window.__CONFIG__ = { flag: "FEATURE_NEW_UI" };
    </script>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="modulepreload" href="/chunk.js" />
  </head>
  <body><div id="__NEXT_DATA__"></div></body>
</html>`;

const APP_JS = `
const API = "https://api.acme.test/graphql";
const LOCAL = "/api/v1/users";
const WS = "wss://socket.acme.test/ws";
const STRIPE = "pk_test_1234567890abcdefghij";
const FLAG = "FEATURE_NEW_UI";
fetch(API); fetch(LOCAL); new WebSocket(WS);
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || {};
`;

const CHUNK_JS = `
export const routes = ["/dashboard", "/users/:id", "/settings/profile"];
export const mode = "enableBetaCheckout";
webpackChunkacme.push([1, {}]);
`;

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private\nAllow: /private/ok\n");
      return;
    }
    if (url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(APP_JS);
      return;
    }
    if (url.pathname === "/chunk.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(CHUNK_JS);
      return;
    }
    if (url.pathname === "/styles.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body{color:#000}");
      return;
    }
    if (url.pathname === "/private" || url.pathname === "/private/ok") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    if (url.pathname === "/ua") {
      const ua = req.headers["user-agent"] ?? "";
      if (!ua.startsWith("Mozilla/")) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("blocked");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    if (url.pathname === "/needs-cookie") {
      const cookie = req.headers.cookie ?? "";
      if (!cookie.includes("session=abc")) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("auth required");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    if (url.pathname === "/forbidden") {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("analyzeWeb builds a full web report from HTML and bundles", async () => {
  const report = await analyzeWeb(`${base}/`, { timeoutMs: 5000 });

  assert.equal(report.schema, "re-tool/web-report@1");
  assert.equal(report.target, `${base}/`);
  assert.equal(report.page.status, 200);
  assert.equal(report.page.title, "Acme Shop");
  assert.match(report.page.contentType, /text\/html/);

  const frameworks = report.frameworks.map((f) => f.name);
  assert.ok(frameworks.includes("React"));
  assert.ok(frameworks.includes("Next.js"));
  assert.ok(frameworks.includes("Webpack"));

  // /app.js + /chunk.js + one inline script
  assert.equal(report.summary.scriptsAnalyzed, 3);
  assert.ok(report.files.some((f) => f.path === "/app.js"));
  assert.ok(report.files.some((f) => f.path === "/chunk.js"));
  assert.ok(report.files.some((f) => f.path === "inline[1]"));
  assert.ok(report.assets.some((a) => a.type === "stylesheet" && a.path === "/styles.css"));

  // findings
  const endpoints = report.endpoints.map((e) => e.value);
  assert.ok(endpoints.includes("https://api.acme.test/graphql"));
  assert.ok(endpoints.includes("wss://socket.acme.test/ws"));
  assert.ok(endpoints.includes("/api/v1/users"));

  const routes = report.routes.map((r) => r.path);
  assert.ok(routes.includes("/dashboard"));
  assert.ok(routes.includes("/users/:id"));

  assert.equal(report.keys.length, 1);
  assert.equal(report.keys[0].kind, "publishable-key");
  assert.equal(report.keys[0].source, "/app.js");

  const flags = report.featureFlags.map((f) => f.name);
  assert.ok(flags.includes("FEATURE_NEW_UI"));

  // report hygiene: internal findings are not serialized
  assert.equal("findings" in report.files[0], false);

  const json = JSON.stringify(report);
  assert.ok(json.length > 0);
});

test("analyzeWeb follows redirects and records the target", async () => {
  const report = await analyzeWeb(`${base}/redirect`, { timeoutMs: 5000 });
  assert.equal(report.target, `${base}/`);
  assert.equal(report.page.redirects.length, 1);
  assert.equal(report.page.redirects[0].from, `${base}/redirect`);
});

test("analyzeWeb respects robots.txt and can be forced with ignoreRobots", async () => {
  await assert.rejects(
    () => analyzeWeb(`${base}/private`, { timeoutMs: 5000 }),
    /Blocked by robots.txt/,
  );

  const allowed = await analyzeWeb(`${base}/private/ok`, { timeoutMs: 5000 });
  assert.equal(allowed.page.robots.allowed, true);

  const forced = await analyzeWeb(`${base}/private`, {
    timeoutMs: 5000,
    ignoreRobots: true,
  });
  assert.equal(forced.page.robots.checked, false);
});

test("analyzeWeb reports HTTP errors as ToolError", async () => {
  await assert.rejects(() => analyzeWeb(`${base}/missing`, { timeoutMs: 5000 }), /HTTP 404/);
});

test("analyzeWeb retries with a browser UA when the site rejects re-tool", async () => {
  const report = await analyzeWeb(`${base}/ua`, { timeoutMs: 5000 });
  assert.equal(report.page.status, 200);
  assert.equal(report.page.userAgentFallback, true);
  assert.match(report.page.userAgent, /^Mozilla\//);
});

test("analyzeWeb keeps a custom UA and explains a 403", async () => {
  await assert.rejects(
    () => analyzeWeb(`${base}/ua`, { timeoutMs: 5000, userAgent: "re-tool-test" }),
    (err) =>
      err instanceof ToolError &&
      /HTTP 403/.test(err.message) &&
      /bot protection/.test(err.message) &&
      /--user-agent/.test(err.message),
  );
});

test("analyzeWeb sends the cookie header and explains a 401", async () => {
  const report = await analyzeWeb(`${base}/needs-cookie`, {
    timeoutMs: 5000,
    cookie: "session=abc",
  });
  assert.equal(report.page.status, 200);

  await assert.rejects(
    () => analyzeWeb(`${base}/needs-cookie`, { timeoutMs: 5000 }),
    /HTTP 401.*authentication/,
  );
});

test("analyzeWeb explains a 403 with actionable hints", async () => {
  await assert.rejects(
    () => analyzeWeb(`${base}/forbidden`, { timeoutMs: 5000 }),
    (err) => /HTTP 403/.test(err.message) && /--cookie/.test(err.message),
  );
});

test("analyzeWeb enforces the total byte budget", async () => {
  const report = await analyzeWeb(`${base}/`, {
    timeoutMs: 5000,
    maxTotalBytes: 1,
    ignoreRobots: true,
  });
  assert.ok(report.summary.skippedAssets >= 1);
  assert.ok(report.summary.scriptsAnalyzed < report.summary.scripts);
  assert.ok(
    report.assets.some((a) => a.error?.includes("byte budget")),
  );
});
