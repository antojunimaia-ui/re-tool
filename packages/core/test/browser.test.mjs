import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  ToolError,
  findBrowser,
  captureWithBrowser,
  detectChallenge,
  analyzeWeb,
} from "../dist/index.js";

const browserPath = findBrowser();
const skipBrowser = browserPath ? false : "no Chromium-based browser installed";

const PAGE = `<!doctype html>
<html>
  <head>
    <title>Loading</title>
    <script src="/app.js"></script>
  </head>
  <body>
    <div id="root">loading</div>
    <script>
      document.cookie = "seen=1; path=/";
      localStorage.setItem("token", "local-secret-123");
      sessionStorage.setItem("mode", "beta");
      fetch("/api/config")
        .then((r) => r.json())
        .then((cfg) => {
          document.getElementById("root").textContent = "ready:" + cfg.mode;
          document.title = "Ready " + cfg.mode;
          const s = document.createElement("script");
          s.src = "/dynamic.js";
          document.head.appendChild(s);
        });
    </script>
  </body>
</html>`;

const APP_JS = `
window.__APP__ = true;
fetch("/api/boot");
`;

const DYNAMIC_JS = `
export const routes = ["/api/dynamic", "/reports/:id"];
export const key = "pk_test_1234567890abcdefghij";
`;

let server;
let base;

test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const ua = req.headers["user-agent"] ?? "";
    const isBrowser = /Chrome|Chromium|Edg\//.test(ua);

    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    };
    const js = (body) => {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(body);
    };

    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    // Simulates bot protection: plain HTTP clients are rejected, browsers pass.
    if (url.pathname === "/challenged") {
      if (!isBrowser) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("blocked");
        return;
      }
      return html(PAGE);
    }
    if (url.pathname === "/need-cookie") {
      const cookie = req.headers.cookie ?? "";
      if (!cookie.includes("session=abc")) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("auth required");
        return;
      }
      return html(PAGE);
    }
    if (url.pathname === "/challenge") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><title>Just a moment...</title></head><body>Checking your browser…</body></html>",
      );
      return;
    }
    if (url.pathname === "/app.js") return js(APP_JS);
    if (url.pathname === "/dynamic.js") return js(DYNAMIC_JS);
    if (url.pathname === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ mode: "spa" }));
      return;
    }
    if (url.pathname === "/api/boot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/") return html(PAGE);

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("findBrowser honours an explicit path and rejects a missing one", () => {
  assert.throws(
    () => findBrowser("C:\\__re_tool_missing_browser__\\chrome.exe"),
    ToolError,
  );
  if (browserPath) {
    assert.equal(findBrowser(browserPath), browserPath);
  }
});

test(
  "captureWithBrowser executes JavaScript, XHR and web storage",
  { skip: skipBrowser, timeout: 120_000 },
  async () => {
    const capture = await captureWithBrowser(`${base}/`, {
      browserPath,
      timeoutMs: 40000,
      settleMs: 1500,
    });

    assert.equal(capture.status, 200);
    assert.match(capture.userAgent, /Chrome|Chromium|Headless/);
    // The title and the DOM are only produced after the XHR resolves.
    assert.match(capture.html, /ready:spa/);
    assert.match(capture.html, /<title>Ready spa<\/title>/);

    const api = capture.responses.find((r) => r.url.endsWith("/api/config"));
    assert.ok(api);
    assert.equal(api.resourceType, "Fetch");
    assert.match(api.body ?? "", /"mode":"spa"/);

    const script = capture.responses.find((r) => r.url.endsWith("/app.js"));
    assert.ok(script);
    assert.equal(script.resourceType, "Script");
    assert.match(script.body ?? "", /__APP__/);

    assert.equal(capture.storage.cookies.find((c) => c.name === "seen")?.value, "1");
    assert.equal(
      capture.storage.localStorage.find((i) => i.name === "token")?.value,
      "local-secret-123",
    );
    assert.equal(
      capture.storage.sessionStorage.find((i) => i.name === "mode")?.value,
      "beta",
    );
  },
);

test(
  "captureWithBrowser sends --cookie and honours a UA override",
  { skip: skipBrowser, timeout: 120_000 },
  async () => {
    const denied = await captureWithBrowser(`${base}/need-cookie`, {
      browserPath,
      timeoutMs: 40000,
      settleMs: 200,
    });
    assert.equal(denied.status, 401);

    const capture = await captureWithBrowser(`${base}/need-cookie`, {
      browserPath,
      timeoutMs: 40000,
      settleMs: 200,
      cookie: "session=abc",
      userAgent: "re-tool-browser-test/1.0",
    });
    assert.equal(capture.status, 200);
    assert.equal(capture.userAgent, "re-tool-browser-test/1.0");
    assert.match(capture.html, /id="root"/);
  },
);

test("detectChallenge spots interstitials and ignores embedded widgets", () => {
  assert.equal(detectChallenge("<title>Just a moment...</title>")?.kind, "cloudflare");
  assert.equal(
    detectChallenge('<script>window._cf_chl_opt = {};</script>')?.kind,
    "cloudflare",
  );
  assert.equal(detectChallenge("<title>DDoS-Guard</title>")?.kind, "ddos-guard");
  assert.equal(
    detectChallenge('<title>Checking your browser before accessing</title>')?.kind,
    "challenge",
  );
  // A site that merely embeds Turnstile in a login form is not a challenge.
  assert.equal(
    detectChallenge(
      '<title>Sign in</title><div class="cf-turnstile" data-sitekey="x"></div>',
    ),
    null,
  );
  assert.equal(detectChallenge("<title>Acme Shop</title><body>hello</body>"), null);
});

test(
  "analyzeWeb refuses to report a challenge page (with --allow-challenge opt-in)",
  { skip: skipBrowser, timeout: 120_000 },
  async () => {
    const capture = await captureWithBrowser(`${base}/challenge`, {
      browserPath,
      timeoutMs: 40000,
    });
    assert.equal(capture.challenge?.kind, "cloudflare");

    await assert.rejects(
      () => analyzeWeb(`${base}/challenge`, { browser: true, browserPath, timeoutMs: 40000 }),
      (err) =>
        err instanceof ToolError &&
        /bot challenge/.test(err.message) &&
        /--headed/.test(err.message) &&
        /--allow-challenge/.test(err.message),
    );

    const report = await analyzeWeb(`${base}/challenge`, {
      browser: true,
      browserPath,
      timeoutMs: 40000,
      allowChallenge: true,
    });
    assert.equal(report.page.capture, "browser");
    assert.equal(report.page.challenge?.kind, "cloudflare");
  },
);

test(
  "analyzeWeb with browser capture handles a bot-protected SPA",
  { skip: skipBrowser, timeout: 120_000 },
  async () => {
    // Plain HTTP is rejected by the fixture (bot protection).
    await assert.rejects(
      () => analyzeWeb(`${base}/challenged`, { timeoutMs: 5000, userAgent: "curl/8" }),
      /HTTP 403/,
    );

    const report = await analyzeWeb(`${base}/challenged`, {
      browser: true,
      browserPath,
      settleMs: 1500,
      timeoutMs: 40000,
    });

    assert.equal(report.page.status, 200);
    assert.equal(report.page.capture, "browser");
    assert.equal(report.page.headed, false);
    assert.equal(report.page.title, "Ready spa");
    assert.match(report.page.userAgent, /Chrome|Chromium|Headless/);

    // Scripts discovered only after JavaScript ran are analyzed from the
    // bodies the browser already downloaded.
    const dynamic = report.assets.find((a) => a.path === "/dynamic.js");
    assert.ok(dynamic);
    assert.equal(dynamic.via, "browser");
    assert.ok(report.files.some((f) => f.path === "/dynamic.js"));

    // XHR request URLs become endpoints, even when they are not string
    // literals in the analyzed bundles.
    const endpoints = report.endpoints.map((e) => e.value);
    assert.ok(endpoints.includes("/api/config"));
    assert.ok(endpoints.includes("/api/boot"));

    // Storage is captured (full values in JSON; the TUI masks them).
    assert.ok(report.storage);
    assert.equal(
      report.storage.cookies.find((c) => c.name === "seen")?.value,
      "1",
    );
    assert.equal(
      report.storage.localStorage.find((i) => i.name === "token")?.value,
      "local-secret-123",
    );

    // The key in the late script is still found.
    assert.ok(report.keys.some((k) => k.kind === "publishable-key"));
  },
);
