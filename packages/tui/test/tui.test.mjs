import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSections,
  renderPreview,
  assertOpenTuiRuntime,
  matchKeyAction,
  getStringsForTui,
} from "../dist/index.js";

function baseString(value, encoding = "plain") {
  return {
    value,
    start: 0,
    end: value.length,
    line: 1,
    column: 1,
    kind: "string",
    encoding,
    length: value.length,
    entropy: 1.5,
  };
}

test("buildSections: standard report (report@2)", () => {
  const report = {
    schema: "re-tool/report@2",
    target: "main.js",
    format: { bundler: "webpack", minified: true, markerSize: 10 },
    webpack: {
      detected: true,
      style: "modern",
      modules: [{ id: "1", path: "./a.js", deps: [], stringCount: 2 }],
      moduleCount: 1,
    },
    sourceMap: { present: false },
    obfuscators: [],
    summary: {
      bytes: 100,
      lines: 3,
      totalStrings: 2,
      reportedStrings: 2,
      totalStringChars: 12,
      averageStringLength: 6,
      highEntropyCount: 0,
      hexEscapedCount: 0,
      unicodeEscapedCount: 0,
      base64LikeCount: 0,
      webpackModules: 1,
      sourceMap: null,
      obfuscators: 0,
    },
    strings: [baseString("abc")],
  };

  const sections = buildSections(report);
  assert.deepEqual(
    sections.map((s) => s.title),
    ["Summary", "Format", "Webpack", "SourceMap", "Obfuscators", "Strings (2)"],
  );

  const wp = sections.find((s) => s.title === "Webpack");
  assert.ok(wp.lines.some((l) => l.includes("#1")));
  assert.ok(wp.lines.some((l) => l.includes("./a.js")));

  const strings = sections.find((s) => s.title.startsWith("Strings"));
  assert.ok(strings.lines.some((l) => l.includes('"abc"')));
});

test("buildSections: electron report (electron-report@1)", () => {
  const report = {
    schema: "re-tool/electron-report@1",
    target: "app.asar",
    asar: { totalFiles: 3, totalBytes: 100, jsFilesAnalyzed: 1, skipped: 2 },
    files: [
      {
        path: "main.js",
        size: 60,
        format: { bundler: "script", minified: false, markerSize: 0 },
        webpackModules: 0,
        obfuscators: [],
        sourceMap: { present: false },
        strings: [baseString("oi")],
        stringTotal: 1,
        stringChars: 2,
      },
    ],
    summary: {
      totalStrings: 1,
      base64Like: 0,
      hexEscaped: 0,
      highEntropy: 0,
      obfuscatorFiles: 0,
      webpackFiles: 0,
    },
  };

  const sections = buildSections(report);
  assert.equal(sections[0].title, "Summary");
  assert.ok(sections.some((s) => s.title === "main.js (1)"));
  const file = sections.find((s) => s.title === "main.js (1)");
  assert.ok(file.lines.some((l) => l.includes("tamanho: 60B")));
});

test("buildSections: hex strings with inFunction show context", () => {
  const hex = baseString("Hello", "hex-escaped");
  hex.inFunction = "decoder";
  const report = {
    schema: "re-tool/report@2",
    target: "x.js",
    format: { bundler: "script", minified: false, markerSize: 0 },
    webpack: { detected: false, style: "unknown", modules: [], moduleCount: 0 },
    sourceMap: { present: false },
    obfuscators: [],
    summary: {
      bytes: 1,
      lines: 1,
      totalStrings: 1,
      reportedStrings: 1,
      totalStringChars: 5,
      averageStringLength: 5,
      highEntropyCount: 0,
      hexEscapedCount: 1,
      unicodeEscapedCount: 0,
      base64LikeCount: 0,
      webpackModules: 0,
      sourceMap: null,
      obfuscators: 0,
    },
    strings: [hex],
  };

  const sections = buildSections(report);
  const line = sections.find((s) => s.title.startsWith("Strings")).lines[0];
  assert.ok(line.includes("hex-escaped"));
  assert.ok(line.includes("decoder"));
});

test("renderPreview produces a structured frame with borders and chips", () => {
  const report = {
    schema: "re-tool/report@2",
    target: "app.js",
    format: { bundler: "webpack", minified: true, markerSize: 10 },
    webpack: {
      detected: true,
      style: "modern",
      modules: [{ id: "1", path: "./a.js", deps: [], stringCount: 2 }],
      moduleCount: 1,
    },
    sourceMap: { present: false },
    obfuscators: [],
    summary: {
      bytes: 100,
      lines: 3,
      totalStrings: 2,
      reportedStrings: 2,
      totalStringChars: 12,
      averageStringLength: 6,
      highEntropyCount: 0,
      hexEscapedCount: 0,
      unicodeEscapedCount: 0,
      base64LikeCount: 0,
      webpackModules: 1,
      sourceMap: null,
      obfuscators: 0,
    },
    strings: [baseString("abc")],
  };

  const frame = renderPreview(report, { cols: 100, rows: 30 });
  assert.ok(frame.includes("┌─ Sections ─"));
  assert.ok(frame.includes("re-tool"));
  assert.ok(frame.includes("re-tool/report@2"));
  assert.ok(frame.includes("[↑↓]"));
  assert.ok(frame.includes("Strings (2)"));
  // limpo: sem sequência de entrada em tela alt no preview
  assert.ok(!frame.includes("\x1b[?1049h"));
});

test("assertOpenTuiRuntime throws with guidance on Node < 26.4", () => {  const m = /^v(\d+)\.(\d+)/.exec(process.version ?? "");
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  if (major > 26 || (major === 26 && minor >= 4)) return; // runtime compatível: skip
  assert.throws(
    () => assertOpenTuiRuntime(),
    (err) => err instanceof Error && err.message.includes("26.4"),
  );
});

test("matchKeyAction recognizes arrows and variants", () => {
  assert.equal(matchKeyAction({ name: "arrowup" }), "up");
  assert.equal(matchKeyAction({ name: "ArrowUp" }), "up");
  assert.equal(matchKeyAction({ name: "up", sequence: "\x1b[A" }), "up");
  assert.equal(matchKeyAction({ sequence: "\x1b[A" }), "up");
  assert.equal(matchKeyAction({ name: "arrowdown" }), "down");
  assert.equal(matchKeyAction({ sequence: "\x1b[B" }), "down");
  assert.equal(matchKeyAction({ name: "pageup" }), "pageup");
  assert.equal(matchKeyAction({ sequence: "\x1b[5~" }), "pageup");
  assert.equal(matchKeyAction({ sequence: "\x1b[6~" }), "pagedown");
  assert.equal(matchKeyAction({ name: "g" }), "top");
  assert.equal(matchKeyAction({ name: "g", shift: true }), "bottom");
  assert.equal(matchKeyAction({ name: "r" }), "redraw");
  assert.equal(matchKeyAction({ name: "q" }), "quit");
  assert.equal(matchKeyAction({ name: "q", eventType: "release" }), null);
  assert.equal(matchKeyAction({ name: "x" }), null);
  assert.equal(matchKeyAction({ name: "enter" }), "confirm");
  assert.equal(matchKeyAction({ sequence: "\r" }), "confirm");
  assert.equal(matchKeyAction({ name: "escape" }), "cancel");
  assert.equal(matchKeyAction({ sequence: "\x1b" }), "cancel");
});

test("getStringsForTui extracts strings with location", () => {
  const mk = (value, over = {}) => ({
    value,
    start: 0,
    end: value.length,
    line: 1,
    column: 1,
    kind: "string",
    encoding: "plain",
    length: value.length,
    entropy: 1.5,
    ...over,
  });
  const report = {
    schema: "re-tool/report@2",
    target: "app.js",
    format: { bundler: "script", minified: false, markerSize: 0 },
    webpack: { detected: false, style: "unknown", modules: [], moduleCount: 0 },
    sourceMap: { present: false },
    obfuscators: [],
    summary: {
      bytes: 1,
      lines: 1,
      totalStrings: 2,
      reportedStrings: 2,
      totalStringChars: 6,
      averageStringLength: 3,
      highEntropyCount: 0,
      hexEscapedCount: 0,
      unicodeEscapedCount: 0,
      base64LikeCount: 0,
      webpackModules: 0,
      sourceMap: null,
      obfuscators: 0,
    },
    strings: [
      mk("abc"),
      mk("xyz", { line: 5, column: 7, ctxBefore: "a=", ctxAfter: ";", inFunction: "f" }),
    ],
  };

  const got = getStringsForTui(report);
  assert.ok(got);
  assert.equal(got.target, "app.js");
  assert.equal(got.strings.length, 2);
  assert.equal(got.strings[1].line, 5);
  assert.equal(got.strings[1].column, 7);
  assert.equal(got.strings[1].ctxBefore, "a=");
  assert.equal(got.strings[1].ctxAfter, ";");
  assert.equal(got.strings[1].inFunction, "f");
});

