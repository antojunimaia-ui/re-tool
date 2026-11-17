import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

import {
  loadAsar,
  parseAsarHeader,
  extractAsarFile,
  extractAsarFiles,
  analyzeAsarApp,
  ToolError,
} from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const asarFixture = path.join(repoRoot, "fixtures/demo-app.asar");

/** Builds an .asar with the official Chromium Pickle prefix (16 bytes). */
function buildPickleAsar(files, { padTo4 = false } = {}) {
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
  prefix.writeUInt32LE(json.length + 8, 4); // pickle payload size
  prefix.writeUInt32LE(json.length + 4, 8);
  prefix.writeUInt32LE(json.length, 12);

  const preBody = Buffer.concat([prefix, json]);
  if (padTo4) {
    const aligned = (preBody.length + 3) & ~3;
    const pad = Buffer.alloc(aligned - preBody.length, 0x20); // spaces
    return Buffer.concat([preBody, pad, ...bodyParts]);
  }
  return Buffer.concat([preBody, ...bodyParts]);
}

test("loadAsar reads the file tree", async () => {
  const { archive } = await loadAsar(asarFixture);
  const paths = archive.entries.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    "assets/config.json",
    "main.js",
    "package.json",
    "renderer.js",
  ]);
  assert.equal(archive.entries.length, 4);
  assert.ok(archive.totalBytes > 0);
});

test("loadAsar rejects invalid files", () => {
  assert.throws(
    () => parseAsarHeader(Buffer.from("nao é um asar")),
    (err) => err instanceof ToolError,
  );
});

test("extractAsarFile restores the original content", async () => {
  const { archive, buffer } = await loadAsar(asarFixture);
  const renderer = archive.entries.find((e) => e.path === "renderer.js");
  assert.ok(renderer);
  const slice = extractAsarFile(buffer, archive, renderer).toString("utf8");
  assert.ok(slice.includes("secret-hint-12345"));
  assert.ok(slice.includes("https://api.demo.example/v1"));
});

test("analyzeAsarApp analyzes internal JS bundles", async () => {
  const report = await analyzeAsarApp(asarFixture);

  assert.equal(report.schema, "re-tool/electron-report@1");
  assert.equal(report.asar.totalFiles, 4);
  assert.equal(report.asar.jsFilesAnalyzed, 2); // main.js + renderer.js
  assert.equal(report.asar.skipped, 2); // package.json + config.json

  assert.equal(report.summary.webpackFiles, 1); // main.js é webpack legado
  assert.equal(report.summary.base64Like, 1); // chave base64 no main.js
  assert.equal(report.summary.obfuscatorFiles, 0);
  assert.ok(report.summary.totalStrings >= 3);

  const main = report.files.find((f) => f.path === "main.js");
  assert.ok(main);
  assert.equal(main.webpackModules, 3);
  assert.equal(main.format.bundler, "webpack");
  assert.equal(main.format.minified, true);
});

test("extractAsarFiles extracts all entries to disk", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "retool-asar-"));
  const summary = await extractAsarFiles(asarFixture, dir);

  assert.equal(summary.extracted, 4);
  assert.equal(summary.skippedUnpacked, 0);
  assert.ok(existsSync(path.join(dir, "main.js")));
  assert.ok(existsSync(path.join(dir, "assets", "config.json")));
  const pkg = readFileSync(path.join(dir, "package.json"), "utf8");
  assert.ok(pkg.includes('"name":"demo-app"'));
});

test("extractAsarFiles extracts specific paths and match patterns", async () => {
  const dir1 = mkdtempSync(path.join(os.tmpdir(), "retool-asar-"));
  const s1 = await extractAsarFiles(asarFixture, dir1, { paths: ["renderer.js"] });
  assert.equal(s1.extracted, 1);
  assert.equal(s1.entries[0], "renderer.js");
  assert.ok(existsSync(path.join(dir1, "renderer.js")));
  assert.ok(!existsSync(path.join(dir1, "main.js")));

  const dir2 = mkdtempSync(path.join(os.tmpdir(), "retool-asar-"));
  const s2 = await extractAsarFiles(asarFixture, dir2, { match: "*.js" });
  assert.equal(s2.extracted, 2); // main.js + renderer.js
  assert.deepEqual([...s2.entries].sort(), ["main.js", "renderer.js"]);
});

test("loadAsar supports the official 16-byte pickle prefix", async () => {
  const buf = buildPickleAsar({
    "a.js": "var a=1;",
    "sub/b.js": '{"x":1}',
  });
  const dir = mkdtempSync(path.join(os.tmpdir(), "retool-pickle-"));
  const file = path.join(dir, "official.asar");
  writeFileSync(file, buf);

  const { archive, buffer } = await loadAsar(file);
  assert.deepEqual(
    archive.entries.map((e) => e.path).sort(),
    ["a.js", "sub/b.js"],
  );
  const a = archive.entries.find((e) => e.path === "a.js");
  assert.equal(extractAsarFile(buffer, archive, a).toString("utf8"), "var a=1;");
  const b = archive.entries.find((e) => e.path === "sub/b.js");
  assert.equal(extractAsarFile(buffer, archive, b).toString("utf8"), '{"x":1}');
});

test("parseAsarHeader skips whitespace padding to 4-byte alignment", async () => {
  const buf = buildPickleAsar({ "a.js": "x" }, { padTo4: true });
  const dir = mkdtempSync(path.join(os.tmpdir(), "retool-pickle-"));
  const file = path.join(dir, "padded.asar");
  writeFileSync(file, buf);

  const { archive, buffer } = await loadAsar(file);
  assert.equal(archive.entries.length, 1);
  const a = archive.entries[0];
  assert.equal(extractAsarFile(buffer, archive, a).toString("utf8"), "x");
});
