import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  safeWebSegments,
  downloadWebFiles,
  analyzeWeb,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

test("safeWebSegments strips queries and hashes", () => {
  assert.deepEqual(safeWebSegments("/static/app.js?v=123&t=456"), ["static", "app.js"]);
  assert.deepEqual(safeWebSegments("bundle.js#line=42"), ["bundle.js"]);
});

test("safeWebSegments handles root and trailing slashes", () => {
  assert.deepEqual(safeWebSegments(""), ["index.html"]);
  assert.deepEqual(safeWebSegments("/"), ["index.html"]);
  assert.deepEqual(safeWebSegments("/docs/"), ["docs", "index.html"]);
});

test("safeWebSegments blocks directory traversal", () => {
  assert.deepEqual(safeWebSegments("../../../etc/passwd"), ["etc", "passwd"]);
  assert.deepEqual(safeWebSegments("/a/../../b/c.js"), ["a", "b", "c.js"]);
});

test("safeWebSegments sanitizes illegal characters", () => {
  assert.deepEqual(safeWebSegments("foo:bar*baz?.js"), ["foo_bar_baz_.js"]);
});

// ---------------------------------------------------------------------------
// downloadWebFiles
// ---------------------------------------------------------------------------

test("downloadWebFiles extracts all files when no selector is given", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-download-"));
  try {
    const files = [
      { path: "index.html", content: "<h1>Hello</h1>", type: "html" },
      { path: "assets/app.js", content: "console.log('hi')", type: "script" },
      { path: "inline-1.js", content: "var a=1;", type: "inline" },
    ];

    const summary = await downloadWebFiles(files, tmpDir);
    assert.equal(summary.downloaded, 3);
    assert.equal(summary.matched, 3);
    assert.ok(summary.bytes > 0);

    const htmlContent = await fs.readFile(path.join(tmpDir, "index.html"), "utf8");
    assert.equal(htmlContent, "<h1>Hello</h1>");

    const jsContent = await fs.readFile(path.join(tmpDir, "assets/app.js"), "utf8");
    assert.equal(jsContent, "console.log('hi')");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("downloadWebFiles filters by specific paths and basenames", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-download-"));
  try {
    const files = [
      { path: "index.html", content: "<h1>Hello</h1>", type: "html" },
      { path: "assets/app.js", content: "console.log('hi')", type: "script" },
      { path: "assets/vendor.js", content: "console.log('vendor')", type: "script" },
    ];

    const summary = await downloadWebFiles(files, tmpDir, { paths: ["app.js"] });
    assert.equal(summary.downloaded, 1);
    assert.deepEqual(summary.entries, ["assets/app.js"]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("downloadWebFiles filters by glob pattern", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-download-"));
  try {
    const files = [
      { path: "index.html", content: "<h1>Hello</h1>", type: "html" },
      { path: "assets/app.js", content: "console.log('hi')", type: "script" },
      { path: "styles/main.css", content: "body { color: red; }", type: "stylesheet" },
    ];

    const summary = await downloadWebFiles(files, tmpDir, { match: "*.css" });
    assert.equal(summary.downloaded, 1);
    assert.deepEqual(summary.entries, ["styles/main.css"]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration with analyzeWeb
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html><html><head>
  <title>Download Test</title>
  <script src="/app.js"></script>
  <script>console.log('inline');</script>
  <link rel="stylesheet" href="/style.css" />
</head><body><p>Test</p></body></html>`;

test("analyzeWeb with download saves discovered files to disk", async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (u.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("var testVal = 42;");
      return;
    }
    if (u.pathname === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end("body { background: #fff; }");
      return;
    }
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-web-download-"));
  try {
    const report = await analyzeWeb(baseUrl, {
      download: tmpDir,
    });

    assert.ok(report.download);
    assert.equal(report.download.downloaded, 4); // index.html, app.js, inline-1.js, style.css
    assert.ok(report.download.entries.includes("index.html"));
    assert.ok(report.download.entries.includes("app.js"));
    assert.ok(report.download.entries.includes("inline-1.js"));
    assert.ok(report.download.entries.includes("style.css"));

    const savedAppJs = await fs.readFile(path.join(tmpDir, "app.js"), "utf8");
    assert.equal(savedAppJs, "var testVal = 42;");
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
