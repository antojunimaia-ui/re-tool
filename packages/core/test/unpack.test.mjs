import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  sanitizeSourcePath,
  extractFilesFromSourceMap,
  unpackSourceMap,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Path sanitization
// ---------------------------------------------------------------------------

test("sanitizeSourcePath strips webpack and bundler schemes", () => {
  assert.equal(sanitizeSourcePath("webpack:///src/index.ts"), "src/index.ts");
  assert.equal(
    sanitizeSourcePath("webpack://my-app/./src/components/Header.vue?vue&type=script"),
    "src/components/Header.vue",
  );
  assert.equal(sanitizeSourcePath("webpack://_N_E/./components/Navbar.tsx"), "components/Navbar.tsx");
  assert.equal(sanitizeSourcePath("vite:///src/main.ts"), "src/main.ts");
  assert.equal(sanitizeSourcePath("turbopack:///[project]/src/page.tsx"), "src/page.tsx");
  assert.equal(sanitizeSourcePath("file:///Users/dev/project/src/index.ts"), "Users/dev/project/src/index.ts");
  assert.equal(sanitizeSourcePath("https://cdn.example.com/assets/app.ts"), "assets/app.ts");
});

test("sanitizeSourcePath blocks directory traversal and Windows drive letters", () => {
  assert.equal(sanitizeSourcePath("../../../etc/passwd"), "etc/passwd");
  assert.equal(sanitizeSourcePath("/a/../../b/c.ts"), "a/b/c.ts");
  assert.equal(sanitizeSourcePath("C:\\dev\\proj\\src\\app.js"), "dev/proj/src/app.js");
  assert.equal(sanitizeSourcePath(""), "source_0.js");
});

test("sanitizeSourcePath replaces illegal filesystem characters", () => {
  assert.equal(sanitizeSourcePath("src/foo:bar*baz?.js"), "src/foo_bar_baz_.js");
});

// ---------------------------------------------------------------------------
// extractFilesFromSourceMap
// ---------------------------------------------------------------------------

test("extractFilesFromSourceMap extracts files and filters node_modules", () => {
  const map = {
    version: 3,
    sources: [
      "webpack:///src/app.ts",
      "webpack:///node_modules/lodash/debounce.js",
      "webpack:///src/utils.ts",
    ],
    sourcesContent: [
      "export const app = 'ok';",
      "module.exports = {};",
      "export const add = (a, b) => a + b;",
    ],
  };

  const all = extractFilesFromSourceMap(map, { excludeNodeModules: false });
  assert.equal(all.files.length, 3);
  assert.equal(all.skippedNodeModules, 0);

  const filtered = extractFilesFromSourceMap(map, { excludeNodeModules: true });
  assert.equal(filtered.files.length, 2);
  assert.equal(filtered.skippedNodeModules, 1);
  assert.deepEqual(
    filtered.files.map((f) => f.relativePath),
    ["src/app.ts", "src/utils.ts"],
  );
});

test("extractFilesFromSourceMap respects glob match and specific paths", () => {
  const map = {
    version: 3,
    sources: ["src/index.ts", "src/style.css", "src/view.tsx"],
    sourcesContent: ["const a = 1;", "body { color: red; }", "export const V = () => null;"],
  };

  const matched = extractFilesFromSourceMap(map, { match: "*.tsx" });
  assert.equal(matched.files.length, 1);
  assert.equal(matched.files[0].relativePath, "src/view.tsx");

  const specific = extractFilesFromSourceMap(map, { paths: ["style.css"] });
  assert.equal(specific.files.length, 1);
  assert.equal(specific.files[0].relativePath, "src/style.css");
});

// ---------------------------------------------------------------------------
// unpackSourceMap file handling
// ---------------------------------------------------------------------------

test("unpackSourceMap unpacks a standalone .map file to disk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-unpack-"));
  const outDir = path.join(tmpDir, "unpacked");

  try {
    const mapPath = path.join(tmpDir, "bundle.js.map");
    const mapContent = {
      version: 3,
      sources: ["webpack:///src/math.ts", "webpack:///src/index.ts"],
      sourcesContent: [
        "export function square(n: number) { return n * n; }",
        "import { square } from './math'; console.log(square(5));",
      ],
    };
    await fs.writeFile(mapPath, JSON.stringify(mapContent), "utf8");

    const summary = await unpackSourceMap(mapPath, outDir);
    assert.equal(summary.sourceMapsFound, 1);
    assert.equal(summary.filesRestored, 2);
    assert.equal(summary.targetType, "map");

    const mathTs = await fs.readFile(path.join(outDir, "src/math.ts"), "utf8");
    assert.match(mathTs, /export function square/);

    const indexTs = await fs.readFile(path.join(outDir, "src/index.ts"), "utf8");
    assert.match(indexTs, /console\.log\(square\(5\)\)/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("unpackSourceMap unpacks a JS file with inline base64 sourcemap", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-unpack-inline-"));
  const outDir = path.join(tmpDir, "out");

  try {
    const mapContent = {
      version: 3,
      sources: ["src/hello.ts"],
      sourcesContent: ["export const greeting = 'Hello world!';"],
    };
    const b64 = Buffer.from(JSON.stringify(mapContent)).toString("base64");
    const jsContent = `console.log('hi');\n//# sourceMappingURL=data:application/json;base64,${b64}`;

    const jsPath = path.join(tmpDir, "app.min.js");
    await fs.writeFile(jsPath, jsContent, "utf8");

    const summary = await unpackSourceMap(jsPath, outDir);
    assert.equal(summary.sourceMapsFound, 1);
    assert.equal(summary.filesRestored, 1);
    assert.equal(summary.targetType, "js");

    const restored = await fs.readFile(path.join(outDir, "src/hello.ts"), "utf8");
    assert.equal(restored, "export const greeting = 'Hello world!';");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("unpackSourceMap unpacks source maps embedded in an Electron .asar archive", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-unpack-asar-"));
  const outDir = path.join(tmpDir, "out");

  try {
    const mapContent = JSON.stringify({
      version: 3,
      sources: ["webpack:///src/electron/main.ts", "webpack:///src/electron/preload.ts"],
      sourcesContent: [
        "const { app } = require('electron'); console.log('main');",
        "console.log('preload');",
      ],
    });

    // Simple pickle asar builder
    const files = {
      "dist/bundle.js.map": mapContent,
      "package.json": JSON.stringify({ name: "demo", main: "dist/bundle.js" }),
    };

    const headerFiles = {};
    const bodyParts = [];
    let offset = 0;

    for (const [p, content] of Object.entries(files)) {
      const buf = Buffer.from(content, "utf8");
      const parts = p.split("/");
      let cur = headerFiles;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        cur[seg] ??= { files: {} };
        cur = cur[seg].files;
      }
      cur[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
      offset += buf.length;
      bodyParts.push(buf);
    }

    const json = Buffer.from(JSON.stringify({ files: headerFiles }), "utf8");
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(json.length + 8, 4);
    prefix.writeUInt32LE(json.length + 4, 8);
    prefix.writeUInt32LE(json.length, 12);

    const asarBuffer = Buffer.concat([prefix, json, ...bodyParts]);
    const asarPath = path.join(tmpDir, "app.asar");
    await fs.writeFile(asarPath, asarBuffer);

    const summary = await unpackSourceMap(asarPath, outDir);
    assert.equal(summary.sourceMapsFound, 1);
    assert.equal(summary.filesRestored, 2);
    assert.equal(summary.targetType, "asar");

    const mainTs = await fs.readFile(path.join(outDir, "src/electron/main.ts"), "utf8");
    assert.match(mainTs, /require\('electron'\)/);

    const preloadTs = await fs.readFile(path.join(outDir, "src/electron/preload.ts"), "utf8");
    assert.match(preloadTs, /console\.log\('preload'\)/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
