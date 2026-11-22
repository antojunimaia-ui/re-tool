import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSections,
  renderPreview,
  getStringsForTui,
} from "../dist/index.js";

function baseString(value) {
  return {
    value,
    start: 0,
    end: value.length,
    line: 1,
    column: 1,
    kind: "string",
    encoding: "plain",
    length: value.length,
    entropy: 1.5,
  };
}

function webReport() {
  return {
    schema: "re-tool/web-report@1",
    target: "https://site.test/",
    requested: "https://site.test/",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    page: {
      status: 200,
      contentType: "text/html",
      bytes: 100,
      title: "Site",
      description: null,
      generator: null,
      baseUrl: "https://site.test/",
      redirects: [],
      robots: { checked: true, allowed: true },
    },
    frameworks: [
      {
        name: "React",
        category: "framework",
        confidence: "high",
        evidence: ["__REACT_DEVTOOLS_GLOBAL_HOOK__"],
      },
    ],
    assets: [
      {
        url: "https://site.test/app.js",
        path: "/app.js",
        type: "script",
        fetched: true,
        bytes: 10,
        status: 200,
        ok: true,
        analyzed: true,
      },
    ],
    files: [
      {
        path: "/app.js",
        url: "https://site.test/app.js",
        size: 10,
        format: { bundler: "script", minified: false, markerSize: 0 },
        webpackModules: 0,
        obfuscators: [],
        sourceMap: { present: false },
        strings: [baseString("abc")],
        stringTotal: 1,
        stringChars: 3,
      },
    ],
    endpoints: [
      { value: "https://api.site.test/v1", kind: "http", count: 2, source: "/app.js", line: 1 },
    ],
    routes: [{ path: "/dashboard", count: 1, source: "/app.js", line: 1 }],
    keys: [
      { kind: "publishable-key", value: "pk_test_1234567890", source: "/app.js", line: 1 },
    ],
    featureFlags: [{ name: "FEATURE_X", source: "/app.js", line: 1 }],
    summary: {
      elapsedMs: 10,
      assets: 1,
      scripts: 1,
      scriptsAnalyzed: 1,
      jsBytes: 10,
      fetchErrors: 0,
      skippedAssets: 0,
      totalStrings: 1,
      frameworks: 1,
      endpoints: 1,
      routes: 1,
      keys: 1,
      featureFlags: 1,
    },
  };
}

test("buildSections: web report (web-report@1)", () => {
  const sections = buildSections(webReport());
  assert.deepEqual(
    sections.map((s) => s.title),
    [
      "Summary",
      "Page",
      "Frameworks (1)",
      "Endpoints (1)",
      "Routes (1)",
      "Keys (1)",
      "Flags (1)",
      "Assets (1)",
      "/app.js (1)",
    ],
  );

  assert.match(sections.at(-1).lines.join("\n"), /abc/);
  assert.match(sections[3].lines[0], /https:\/\/api\.site\.test\/v1/);
  assert.match(sections[3].lines[0], /x2/);
});

test("buildSections: web report masks keys in the TUI", () => {
  const sections = buildSections(webReport());
  const keys = sections.find((s) => s.title === "Keys (1)");
  assert.ok(keys.lines[0].includes("publishable-key"));
  assert.ok(!keys.lines[0].includes("pk_test_1234567890"));
});

test("getStringsForTui: web report strings keep the asset path", () => {
  const result = getStringsForTui(webReport());
  assert.equal(result.target, "https://site.test/");
  assert.equal(result.strings.length, 1);
  assert.equal(result.strings[0].file, "/app.js");
  assert.equal(result.strings[0].value, "abc");
});

test("buildSections: runtime network capture adds a Runtime section", () => {
  const report = webReport();
  report.summary.runtimeSeconds = 4;
  report.runtime = {
    seconds: 4,
    requests: [
      {
        ts: 120,
        kind: "fetch",
        method: "GET",
        url: "https://api.site.test/v1/poll",
        status: 200,
        mimeType: "application/json",
        bytes: 512,
      },
    ],
    websockets: [
      { ts: 300, direction: "recv", payloadLength: 64, preview: '{"ok":true}' },
    ],
  };

  const sections = buildSections(report);
  const summary = sections.find((s) => s.title === "Summary");
  assert.ok(summary.lines.some((l) => l.includes("runtime 4s")));
  assert.ok(summary.lines.some((l) => l.includes("1 requests")));

  const runtime = sections.find((s) => s.title === "Runtime (2)");
  assert.ok(runtime, "Runtime section expected");
  const text = runtime.lines.join("\n");
  assert.ok(text.includes("GET https://api.site.test/v1/poll → 200"));
  assert.ok(text.includes("ws recv 64B"));
  assert.ok(!text.includes('{"ok":true}'), "websocket payload must be masked");
});

test("renderPreview: web report renders a frame", () => {
  const frame = renderPreview(webReport());
  assert.ok(frame.includes("re-tool/web-report@1"));
  assert.ok(frame.includes("Endpoints"));
});

test("buildSections: partial coverage adds a Gaps section and updates Summary", () => {
  const report = webReport();
  report.coverage = {
    status: "partial",
    discoveredScripts: 10,
    analyzedScripts: 2,
    scriptsSkipped: 8,
    scriptsSkippedByLimit: 7,
    scriptsSkippedByBudget: 1,
    requestsFailed: 0,
    bytesTruncated: true,
    gaps: [
      {
        kind: "script-limit",
        count: 7,
        message: "7 script(s) were not analyzed because of --max-scripts 5.",
        assets: ["https://site.test/missed.js"],
      },
      { kind: "truncated", count: 1, message: "1 script body was cut.", assets: [] },
    ],
  };

  const sections = buildSections(report);
  const summary = sections.find((s) => s.title === "Summary");
  assert.ok(summary.lines.some((l) => l.includes("partial")));
  assert.ok(summary.lines.some((l) => l.includes("2/10")));
  assert.ok(summary.lines.some((l) => l.includes("truncated")));

  const gaps = sections.find((s) => s.title === "Gaps (2)");
  assert.ok(gaps, "Gaps section expected for partial coverage");
  const text = gaps.lines.join("\n");
  assert.ok(text.includes("script-limit x7"));
  assert.ok(text.includes("truncated x1"));
});

test("renderPreview: partial coverage shows the partial chip", () => {
  const report = webReport();
  report.coverage = {
    status: "partial",
    discoveredScripts: 10,
    analyzedScripts: 2,
    scriptsSkipped: 8,
    scriptsSkippedByLimit: 8,
    scriptsSkippedByBudget: 0,
    requestsFailed: 0,
    bytesTruncated: false,
    gaps: [
      { kind: "script-limit", count: 8, message: "8 skipped.", assets: [] },
    ],
  };
  const frame = renderPreview(report);
  assert.ok(frame.includes("partial"));
});


test("buildSections: browser capture shows the mode and masked storage", () => {
  const report = webReport();
  report.page.capture = "browser";
  report.page.userAgent = "Mozilla/5.0 Chrome/131.0.0.0";
  report.storage = {
    cookies: [{ name: "sid", value: "supersecretcookievalue", domain: "site.test" }],
    localStorage: [{ name: "token", value: "local-secret-123" }],
    sessionStorage: [{ name: "mode", value: "beta" }],
  };

  const sections = buildSections(report);
  const page = sections.find((s) => s.title === "Page");
  assert.ok(page.lines.some((l) => l.includes("capture: headless browser")));

  const storage = sections.find((s) => s.title.startsWith("Storage"));
  assert.ok(storage);
  const text = storage.lines.join("\n");
  assert.ok(text.includes("cookie sid"));
  assert.ok(text.includes("localStorage: 1"));
  assert.ok(!text.includes("supersecretcookievalue"));
  assert.ok(!text.includes("local-secret-123"));
});
