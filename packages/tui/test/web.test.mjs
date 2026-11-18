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

test("renderPreview: web report renders a frame", () => {
  const frame = renderPreview(webReport());
  assert.ok(frame.includes("re-tool/web-report@1"));
  assert.ok(frame.includes("Endpoints"));
});
