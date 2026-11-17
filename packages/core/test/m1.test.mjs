import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  readSource,
  detectFormat,
  isMinified,
  extractStrings,
  parseErrorOf,
  shannonEntropy,
  beautify,
  scanSource,
} from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sampleFile = path.join(repoRoot, "sample.js");

// ---------------------------------------------------------------------------
// Detecção de formato
// ---------------------------------------------------------------------------

const WEBPACK = `!function(e){var t={};function r(n){if(t[n])return t[n].exports;var o=t[n]={i:n,l:false,exports:{}};return e[n].call(o.exports,o,o.exports,r),o.l=true,o.exports}var __webpack_require__=r;return __webpack_require__}();`;
const BROWSERIFY = `(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);var f=new Error("Cannot find module '"+o+"'")}throw f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return s}));`;
const ESBUILD = `(()=>{var __defProp=Object.defineProperty;var __name=(target,value)=>Object.defineProperty(target,"name",{value,configurable:true});var foo=()=>42;__name(foo,"foo");})();`;
const ROLLUP = `import{foo}from"./foo.js";Object.defineProperty(exports,"__esModule",{value:true});exports.foo=foo;`;

test("detectFormat identifies webpack", () => {
  assert.equal(detectFormat(WEBPACK).bundler, "webpack");
});

test("detectFormat identifies browserify", () => {
  assert.equal(detectFormat(BROWSERIFY).bundler, "browserify");
});

test("detectFormat identifies esbuild", () => {
  assert.equal(detectFormat(ESBUILD).bundler, "esbuild");
});

test("detectFormat identifies rollup", () => {
  assert.equal(detectFormat(ROLLUP).bundler, "rollup");
});

test("detectFormat returns script for common code", () => {
  assert.equal(detectFormat("const a = 1; console.log(a);").bundler, "script");
});

test("isMinified detects giant single line and rejects normal code", () => {
  assert.equal(isMinified("x".repeat(2000)), true);
  assert.equal(isMinified("const a = 1;\nconst b = 2;\n"), false);
});

// ---------------------------------------------------------------------------
// Entropia
// ---------------------------------------------------------------------------

test("shannonEntropy: repeated chars = 0, uniform = log2(n)", () => {
  assert.equal(shannonEntropy("aaaa"), 0);
  assert.equal(shannonEntropy("abcd"), 2);
});

// ---------------------------------------------------------------------------
// Extração de strings
// ---------------------------------------------------------------------------

test("extractStrings extracts the literals from sample.js", async () => {
  const source = await readSource(sampleFile);
  const strings = extractStrings(source.content);

  assert.equal(strings.length, 5);
  assert.ok(strings.some((s) => s.value === "secret-token-123"));
  assert.ok(strings.some((s) => s.value === "https://api.example.com/v1"));
  assert.ok(strings.some((s) => s.value === "using token:"));

  const hex = strings.find((s) => s.encoding === "hex-escaped");
  assert.ok(hex, "deve existir uma string com escape hex");
  assert.equal(hex.value, "hex encoded");
  assert.equal(hex.length, 11);
  assert.ok(hex.ctxBefore !== undefined);
  assert.ok(hex.ctxAfter !== undefined);
});

test("extractStrings identifies the enclosing function", async () => {
  const source = await readSource(sampleFile);
  const strings = extractStrings(source.content);
  const inside = strings.find((s) => s.value === "using token:");
  assert.equal(inside?.inFunction, "fetchData");
});

test("extractStrings keeps offsets/lines consistent", async () => {
  const source = await readSource(sampleFile);
  const strings = extractStrings(source.content);
  for (const s of strings) {
    assert.equal(s.end - s.start, source.content.slice(s.start, s.end).length);
    assert.ok(s.start >= 0 && s.end <= source.content.length);
    if (s.encoding === "plain") {
      assert.ok(source.content.slice(s.start, s.end).includes(s.value));
    } else {
      assert.match(
        source.content.slice(s.start, s.end),
        /\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/,
      );
    }
  }
});

test("parseErrorOf is undefined for valid code and set for invalid", () => {
  assert.equal(parseErrorOf("const a = 1;"), undefined);
  assert.ok(typeof parseErrorOf("this is not valid ((((") === "string");
});

test("extractStrings with fallback does not throw for invalid JS", () => {
  const strings = extractStrings("not valid javascript ((((");
  assert.ok(Array.isArray(strings));
});

// ---------------------------------------------------------------------------
// Beautify
// ---------------------------------------------------------------------------

test("beautify reformats compact code", async () => {
  const result = await beautify("const a={b:1};const c=[1,2,3];");
  assert.equal(result.ok, true);
  assert.ok(result.code.includes("const a = { b: 1 }"));
});

test("beautify returns original with ok=false for unparseable content", async () => {
  const result = await beautify("this is not valid ((((");
  assert.equal(result.ok, false);
  assert.equal(result.code, "this is not valid ((((");
  assert.ok(result.error);
});

// ---------------------------------------------------------------------------
// Relatório (scan)
// ---------------------------------------------------------------------------

test("scanSource produces a report with a correct summary", async () => {
  const source = await readSource(sampleFile);
  const report = await scanSource(source);

  assert.equal(report.schema, "re-tool/report@2");
  assert.equal(report.target, sampleFile);
  assert.equal(report.format.bundler, "script");
  assert.equal(report.format.minified, false);
  assert.equal(report.summary.totalStrings, 5);
  assert.equal(report.summary.reportedStrings, 5);
  assert.equal(report.summary.hexEscapedCount, 1);
  assert.equal(report.summary.base64LikeCount, 0);
  assert.equal(report.summary.highEntropyCount, 0);
  assert.ok(report.summary.bytes > 0);
  assert.ok(report.summary.lines > 0);
});

test("scanSource respects minLength", async () => {
  const source = await readSource(sampleFile);
  const report = await scanSource(source, { minLength: 16 });
  assert.equal(report.summary.totalStrings, 2); // secret-token-123 e a URL
});

test("scanSource includes parseError when the parser fails", async () => {
  const fakeSource = { path: "x.js", content: "not valid ((((", lines: ["not valid (((("] };
  const report = await scanSource(fakeSource);
  assert.ok(report.parseError);
  // strings vieram do fallback (array, mesmo que vazio)
  assert.ok(Array.isArray(report.strings));
});
