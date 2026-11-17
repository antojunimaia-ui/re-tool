import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  analyzeWebpack,
  recoverSourceMap,
  detectObfuscators,
  readSource,
  scanSource,
} from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sampleFile = path.join(repoRoot, "sample.js");
const extMapMain = path.join(repoRoot, "fixtures/extmap/main.js");

// ---------------------------------------------------------------------------
// Webpack: grafo de módulos
// ---------------------------------------------------------------------------

const MODERN_WEBPACK = `
(() => {
  var __webpack_modules__ = {
    1: (module, exports, __webpack_require__) => {
      module.exports = { greeting: "olá" };
    },
    /*! ./src/a.js */
    2: (module, exports, __webpack_require__) => {
      const a = __webpack_require__(1);
      console.log(a.greeting);
    },
    3: (module, exports, __webpack_require__) => {
      const b = __webpack_require__(2);
      exports.b = b;
    }
  };
  var __webpack_module_cache__ = {};
  function __webpack_require__(moduleId) {
    var cachedModule = __webpack_module_cache__[moduleId];
    if (cachedModule !== undefined) return cachedModule.exports;
    var module = __webpack_module_cache__[moduleId] = { exports: {} };
    __webpack_modules__[moduleId](module, module.exports, __webpack_require__);
    return module.exports;
  }
  __webpack_require__(3);
})();
`;

const LEGACY_WEBPACK = `!function(e){var t={};function r(n){if(t[n])return t[n].exports;var o=t[n]={i:n,l:false,exports:{}};return e[n].call(o.exports,o,o.exports,r),o.l=true,o.exports}r.m=e;return r}([function(module,exports,r){module.exports="a"},function(module,exports,r){module.exports=r(0)+"b"}]);`;

test("analyzeWebpack: modern format (__webpack_modules__)", () => {
  const analysis = analyzeWebpack(MODERN_WEBPACK);
  assert.equal(analysis.detected, true);
  assert.equal(analysis.style, "modern");
  assert.equal(analysis.moduleCount, 3);

  const byId = new Map(analysis.modules.map((m) => [m.id, m]));
  assert.deepEqual(byId.get("1")?.deps, []);
  assert.deepEqual(byId.get("2")?.deps, [1]);
  assert.deepEqual(byId.get("3")?.deps, [2]);
  assert.equal(byId.get("2")?.path, "./src/a.js");
});

test("analyzeWebpack: legacy format (!function(e){...}([...]))", () => {
  const analysis = analyzeWebpack(LEGACY_WEBPACK);
  assert.equal(analysis.detected, true);
  assert.equal(analysis.style, "legacy");
  assert.equal(analysis.moduleCount, 2);
  const byId = new Map(analysis.modules.map((m) => [m.id, m]));
  assert.deepEqual(byId.get("1")?.deps, [0]);
});

test("analyzeWebpack: common code is not detected as webpack", () => {
  const analysis = analyzeWebpack("const a = 1; console.log(a);");
  assert.equal(analysis.detected, false);
  assert.equal(analysis.moduleCount, 0);
});

// ---------------------------------------------------------------------------
// Source maps
// ---------------------------------------------------------------------------

test("recoverSourceMap: inline base64", async () => {
  const map = {
    version: 3,
    sources: ["a.js", "b.js"],
    names: [],
    sourcesContent: ["var a=1;", "var b=2;"],
  };
  const b64 = Buffer.from(JSON.stringify(map)).toString("base64");
  const content = "var x=1;\n//# sourceMappingURL=data:application/json;base64," + b64;

  const info = await recoverSourceMap(content, sampleFile);
  assert.equal(info.present, true);
  assert.equal(info.kind, "inline");
  assert.deepEqual(info.sources, ["a.js", "b.js"]);
  assert.equal(info.hasSourcesContent, true);
  assert.equal(info.sourcesContentCount, 2);
});

test("recoverSourceMap: external file", async () => {
  const source = await readSource(extMapMain);
  const info = await recoverSourceMap(source.content, source.path);
  assert.equal(info.present, true);
  assert.equal(info.kind, "file");
  assert.ok(info.sources?.includes("src/orig.ts"));
  assert.equal(info.version, 3);
});

test("recoverSourceMap: missing external map yields friendly error", async () => {
  const info = await recoverSourceMap("//# sourceMappingURL=missing.map", sampleFile);
  assert.equal(info.present, true);
  assert.equal(info.kind, "file");
  assert.ok(info.error?.includes("not found"));
});

test("recoverSourceMap: without directive returns present=false", async () => {
  const info = await recoverSourceMap("var a = 1;", sampleFile);
  assert.equal(info.present, false);
});

// ---------------------------------------------------------------------------
// Obfuscators
// ---------------------------------------------------------------------------

const OBFUSCATED = `function _0x1234(){var _0x5678=['\\x48\\x65\\x6c\\x6c\\x6f','\\x57\\x6f\\x72\\x6c\\x64'];return function(_0xabcd){return _0x5678[_0xabcd]}}var _0x2f3c=_0x1234();while(true){switch(_0x2f3c[0]){case 0:console.log(_0x2f3c[1]);break;default:break}}`;

const PACKER = `eval(function(p,a,c,k,e,r){e=String;if(!''.replace(/^/,String)){while(c--)r[c]=k[c]||c;k=[function(e){return r[e]}];e=function(){return'\\w+'};c=1};while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p}('0',1,1,'hi'.split('|'),0,{}))`;

test("detectObfuscators: javascript-obfuscator", () => {
  const findings = detectObfuscators(OBFUSCATED);
  assert.ok(findings.length >= 1);
  const main = findings[0];
  assert.equal(main.name, "javascript-obfuscator");
  assert.ok(main.confidence >= 0.6);
  assert.ok(main.signals.some((s) => s.includes("flattening")));
});

test("detectObfuscators: Dean Edwards packer", () => {
  const findings = detectObfuscators(PACKER);
  assert.ok(findings.some((f) => f.name === "dean-edwards-packer"));
});

test("detectObfuscators: simple code yields no findings", () => {
  assert.deepEqual(detectObfuscators("const a = 1; console.log(a);"), []);
});

// ---------------------------------------------------------------------------
// Integração no relatório
// ---------------------------------------------------------------------------

test("scanSource integrates webpack/sourceMap/obfuscators (v2)", async () => {
  const source = await readSource(sampleFile);
  const report = await scanSource(source);

  assert.equal(report.schema, "re-tool/report@2");
  assert.equal(report.summary.webpackModules, 0);
  assert.equal(report.summary.sourceMap, null);
  assert.equal(report.summary.obfuscators, 0);
  assert.equal(report.webpack.detected, false);
  assert.equal(report.sourceMap.present, false);
  assert.deepEqual(report.obfuscators, []);
});

test("scanSource detects webpack modules in the legacy fixture", async () => {
  const fixture = path.join(repoRoot, "fixtures/webpack.min.js");
  const source = await readSource(fixture);
  const report = await scanSource(source);

  assert.equal(report.webpack.detected, true);
  assert.equal(report.webpack.style, "legacy");
  assert.equal(report.summary.webpackModules, 3);
  assert.equal(report.summary.sourceMap, null);
});
