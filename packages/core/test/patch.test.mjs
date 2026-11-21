import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  packAsar,
  patchAsar,
  loadAsar,
  extractAsarFile,
  extractAsarFiles,
  ToolError,
} from "../dist/index.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "retool-patch-test-"));
}

test("packAsar packs a directory structure into a valid ASAR archive", async () => {
  const tmpDir = await makeTempDir();
  try {
    const srcDir = path.join(tmpDir, "app");
    await fs.mkdir(path.join(srcDir, "lib"), { recursive: true });
    await fs.writeFile(path.join(srcDir, "package.json"), JSON.stringify({ name: "my-app", main: "index.js" }));
    await fs.writeFile(path.join(srcDir, "index.js"), 'console.log("hello world");');
    await fs.writeFile(path.join(srcDir, "lib/calc.js"), "export const add = (a, b) => a + b;");

    const outAsar = path.join(tmpDir, "app.asar");
    const result = await packAsar(srcDir, outAsar);

    assert.equal(result.totalFiles, 3);
    assert.equal(result.unpackedFiles, 0);
    assert.deepEqual(result.entries.sort(), ["index.js", "lib/calc.js", "package.json"]);

    // Verify loading and extraction
    const loaded = await loadAsar(outAsar);
    assert.equal(loaded.archive.entries.length, 3);

    const indexEntry = loaded.archive.entries.find((e) => e.path === "index.js");
    assert.ok(indexEntry);
    const content = extractAsarFile(loaded.buffer, loaded.archive, indexEntry);
    assert.equal(content.toString("utf8"), 'console.log("hello world");');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("packAsar honours --unpack pattern and moves matching files to .unpacked", async () => {
  const tmpDir = await makeTempDir();
  try {
    const srcDir = path.join(tmpDir, "app");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'console.log("main");');
    await fs.writeFile(path.join(srcDir, "native.node"), Buffer.from([0x01, 0x02, 0x03, 0x04]));

    const outAsar = path.join(tmpDir, "app.asar");
    const result = await packAsar(srcDir, outAsar, { unpack: "*.node" });

    assert.equal(result.totalFiles, 2);
    assert.equal(result.unpackedFiles, 1);
    assert.ok(result.unpackedDir);

    const unpackedFilePath = path.join(`${outAsar}.unpacked`, "native.node");
    const unpackedBytes = await fs.readFile(unpackedFilePath);
    assert.deepEqual(unpackedBytes, Buffer.from([0x01, 0x02, 0x03, 0x04]));

    const loaded = await loadAsar(outAsar);
    const nativeEntry = loaded.archive.entries.find((e) => e.path === "native.node");
    assert.ok(nativeEntry);
    assert.equal(nativeEntry.unpacked, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("patchAsar replaces files and adds new files", async () => {
  const tmpDir = await makeTempDir();
  try {
    const srcDir = path.join(tmpDir, "app");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'const isProd = true;');
    const asarPath = path.join(tmpDir, "app.asar");
    await packAsar(srcDir, asarPath);

    const newMain = path.join(tmpDir, "new-main.js");
    await fs.writeFile(newMain, 'const isProd = false; // patched');

    const outPath = path.join(tmpDir, "patched.asar");
    const patchRes = await patchAsar(asarPath, {
      out: outPath,
      replaceFiles: {
        "main.js": newMain,
        "injected.js": Buffer.from('console.log("injected!");', "utf8"),
      },
    });

    assert.deepEqual(patchRes.modified, ["main.js"]);
    assert.deepEqual(patchRes.added, ["injected.js"]);
    assert.equal(patchRes.totalFiles, 2);

    const loaded = await loadAsar(outPath);
    const mainEntry = loaded.archive.entries.find((e) => e.path === "main.js");
    assert.equal(extractAsarFile(loaded.buffer, loaded.archive, mainEntry).toString("utf8"), 'const isProd = false; // patched');

    const injectedEntry = loaded.archive.entries.find((e) => e.path === "injected.js");
    assert.equal(extractAsarFile(loaded.buffer, loaded.archive, injectedEntry).toString("utf8"), 'console.log("injected!");');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("patchAsar removes files from archive", async () => {
  const tmpDir = await makeTempDir();
  try {
    const srcDir = path.join(tmpDir, "app");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'main');
    await fs.writeFile(path.join(srcDir, "telemetry.js"), 'sendTelemetry()');
    const asarPath = path.join(tmpDir, "app.asar");
    await packAsar(srcDir, asarPath);

    const outPath = path.join(tmpDir, "clean.asar");
    const patchRes = await patchAsar(asarPath, {
      out: outPath,
      removeFiles: ["telemetry.js"],
    });

    assert.deepEqual(patchRes.removed, ["telemetry.js"]);
    assert.equal(patchRes.totalFiles, 1);

    const loaded = await loadAsar(outPath);
    assert.equal(loaded.archive.entries.length, 1);
    assert.equal(loaded.archive.entries[0].path, "main.js");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("patchAsar performs search/replace, prepend and append in-place with backup", async () => {
  const tmpDir = await makeTempDir();
  try {
    const srcDir = path.join(tmpDir, "app");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'function run() {\n  const licenseValid = false;\n  return licenseValid;\n}');
    const asarPath = path.join(tmpDir, "app.asar");
    await packAsar(srcDir, asarPath);

    const patchRes = await patchAsar(asarPath, {
      replaceText: [
        {
          file: "main.js",
          search: "licenseValid = false",
          replace: "licenseValid = true",
        },
      ],
      prepend: [
        {
          file: "main.js",
          content: "// Header comment\n",
        },
      ],
      append: [
        {
          file: "main.js",
          content: "\n// Footer comment",
        },
      ],
      backup: true,
    });

    assert.equal(patchRes.outPath, asarPath);
    assert.ok(patchRes.backupPath);
    assert.equal(await fs.stat(patchRes.backupPath).then(() => true).catch(() => false), true);

    const loaded = await loadAsar(asarPath);
    const mainContent = extractAsarFile(loaded.buffer, loaded.archive, loaded.archive.entries[0]).toString("utf8");
    assert.ok(mainContent.startsWith("// Header comment\n"));
    assert.ok(mainContent.includes("licenseValid = true;"));
    assert.ok(mainContent.endsWith("\n// Footer comment"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("patchAsar throws ToolError when search term does not match", async () => {
  const tmpDir = await makeTempDir();
  try {
    const srcDir = path.join(tmpDir, "app");
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'console.log("hello");');
    const asarPath = path.join(tmpDir, "app.asar");
    await packAsar(srcDir, asarPath);

    await assert.rejects(
      async () => {
        await patchAsar(asarPath, {
          replaceText: [
            {
              file: "main.js",
              search: "nonexistent",
              replace: "replacement",
            },
          ],
        });
      },
      (err) => err instanceof ToolError && err.message.includes("Search term not found"),
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
