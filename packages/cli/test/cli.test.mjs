import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  optValue,
  hasFlag,
  parseNonNegativeInt,
} from "../dist/args.js";
import {
  tools,
  getTool,
  callTool,
  adaptTools,
} from "../dist/tools.js";
import { ToolError } from "re-tool-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI_PATH = path.join(ROOT, "packages/cli/dist/index.js");

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
    ...opts,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function runCliAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT,
      ...opts,
    });
    let stdout = "";
    let stderr = "";
    if (cp.stdout) cp.stdout.on("data", (d) => { stdout += d.toString(); });
    if (cp.stderr) cp.stderr.on("data", (d) => { stderr += d.toString(); });
    cp.on("error", reject);
    cp.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Argument Parser Unit Tests
// ---------------------------------------------------------------------------

test("parseArgs: extracts positional arguments", () => {
  const parsed = parseArgs(["search", "token", "extra"]);
  assert.deepEqual(parsed.positional, ["search", "token", "extra"]);
  assert.equal(parsed.options.size, 0);
  assert.equal(parsed.bools.size, 0);
});

test("parseArgs: extracts --key=value and --key value options", () => {
  const parsed = parseArgs(["scan", "--file=app.js", "--limit", "20"]);
  assert.deepEqual(parsed.positional, ["scan"]);
  assert.equal(optValue(parsed.options, "file"), "app.js");
  assert.equal(optValue(parsed.options, "limit"), "20");
});

test("parseArgs: --watch takes a numeric value and does not eat positionals", () => {
  const parsed = parseArgs(["web", "https://example.com", "--watch", "8"]);
  assert.deepEqual(parsed.positional, ["web", "https://example.com"]);
  assert.equal(optValue(parsed.options, "watch"), "8");
  assert.ok(!parsed.bools.has("watch")); // value option, not a bool flag
});

test("parseArgs: --connect captures the CDP endpoint", () => {
  const parsed = parseArgs(["web", "https://example.com", "--connect", "http://127.0.0.1:9222"]);
  assert.deepEqual(parsed.positional, ["web", "https://example.com"]);
  assert.equal(optValue(parsed.options, "connect"), "http://127.0.0.1:9222");
});

// ---------------------------------------------------------------------------
// Tool-call surface (core-direct handlers, no CLI spawn)
// ---------------------------------------------------------------------------

test("tools: canonical registry exposes the expected tool names", () => {
  const names = tools.map((t) => t.name);
  for (const expected of ["search", "extract", "scan", "asar", "beautify", "decode", "web", "audit"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // every tool has the full contract
  for (const t of tools) {
    assert.ok(typeof t.name === "string" && t.name.length > 0);
    assert.ok(typeof t.description === "string" && t.description.length > 0);
    assert.ok(t.inputSchema && t.inputSchema.type === "object");
    assert.ok(Array.isArray(t.sideEffects));
    assert.equal(typeof t.handler, "function");
  }
});

test("tools: handlers call the core directly (search/scan/decode)", async () => {
  const target = path.join(ROOT, "packages/core/src/errors.ts");

  const search = await callTool("search", { file: target, term: "ToolError", limit: 2 });
  assert.equal(search.totalMatches, 2);
  assert.equal(search.shown, 2);

  const scan = await callTool("scan", { file: target, limit: 5 });
  assert.equal(scan.schema, "re-tool/report@2");
  assert.ok(scan.format);
  assert.ok(scan.summary.totalStrings >= 0);

  const dec = await callTool("decode", { input: "aGVsbG8gd29ybGQ=" });
  assert.equal(dec.detected, "base64");
  assert.equal(dec.decoded, "hello world");
});

test("tools: web handler returns a web report (phase 1, no browser)", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`
      <!doctype html><html><head><title>Tool Web</title></head>
      <body><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const report = await callTool("web", { url, timeoutMs: 8000 });
    assert.equal(report.schema, "re-tool/web-report@1");
    assert.equal(report.page.status, 200);
    assert.equal(report.page.capture, "http");
    assert.equal(report.page.title, "Tool Web");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tools: adaptTools maps to openai/anthropic/custom schemas", () => {
  const openai = adaptTools("openai");
  const first = openai[0];
  assert.equal(first.type, "function");
  assert.equal(first.function.name, "search");
  assert.equal(first.function.parameters.type, "object");

  const anthropic = adaptTools("anthropic");
  assert.equal(anthropic[0].name, "search");
  assert.ok("input_schema" in anthropic[0]);

  const custom = adaptTools("custom", (t) => ({
    method: t.name,
    argsSchema: t.inputSchema,
    security: t.sideEffects,
  }));
  assert.deepEqual(custom[0], {
    method: "search",
    argsSchema: getTool("search").inputSchema,
    security: ["readonly"],
  });

  // default: canonical array copy
  const canonical = adaptTools("custom");
  assert.equal(canonical.length, tools.length);
  assert.notEqual(canonical, tools); // copy
});

test("tools: unknown tool throws ToolError with exit code 2", () => {
  assert.throws(() => getTool("nope"), (e) => e instanceof ToolError && e.exitCode === 2);
});

test("parseArgs: flags in BOOL_FLAGS never consume the next argument", () => {
  const parsed = parseArgs(["search", "token", "--json", "--file", "main.js"]);
  assert.deepEqual(parsed.positional, ["search", "token"]);
  assert.ok(hasFlag(parsed.bools, parsed.options, "json"));
  assert.equal(optValue(parsed.options, "file"), "main.js");
});

test("parseArgs: handles short flags (-f, -c, -i, -r)", () => {
  const parsed = parseArgs(["search", "term", "-f", "sample.js", "-i", "-c", "250"]);
  assert.deepEqual(parsed.positional, ["search", "term"]);
  assert.equal(optValue(parsed.options, "file", "f"), "sample.js");
  assert.ok(hasFlag(parsed.bools, parsed.options, "ignore-case", "i"));
  assert.equal(optValue(parsed.options, "context", "c"), "250");
});

test("parseArgs: honours '--' to separate trailing positional arguments", () => {
  const parsed = parseArgs(["extract", "--unique", "--", "--not-a-flag", "literal"]);
  assert.ok(hasFlag(parsed.bools, parsed.options, "unique"));
  assert.deepEqual(parsed.positional, ["extract", "--not-a-flag", "literal"]);
});

test("parseNonNegativeInt: validates and parses integers", () => {
  assert.equal(parseNonNegativeInt("42", 10, "Test"), 42);
  assert.equal(parseNonNegativeInt(undefined, 10, "Test"), 10);
  assert.throws(() => parseNonNegativeInt("-1", 0, "Test"), /must be an integer >= 0/);
  assert.throws(() => parseNonNegativeInt("abc", 0, "Test"), /must be an integer >= 0/);
});

// ---------------------------------------------------------------------------
// CLI Execution End-to-End Tests
// ---------------------------------------------------------------------------

test("CLI: prints version with code 0 on 'version' or '-v'", () => {
  const res1 = runCli(["version"]);
  assert.equal(res1.status, 0);
  assert.match(res1.stdout, /re-tool \d+\.\d+\.\d+/);

  const res2 = runCli(["-v"]);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /re-tool \d+\.\d+\.\d+/);
});

test("CLI: prints help with code 0 on 'help', '--help', '-h' or empty args", () => {
  const res1 = runCli(["help"]);
  assert.equal(res1.status, 0);
  assert.match(res1.stdout, /Commands:/);
  assert.match(res1.stdout, /search <term>/);

  const res2 = runCli([]);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /re-tool — reverse engineering assistant/);

  const res3 = runCli(["--help"]);
  assert.equal(res3.status, 0);
  assert.match(res3.stdout, /Commands:/);

  const res4 = runCli(["-h"]);
  assert.equal(res4.status, 0);
  assert.match(res4.stdout, /Commands:/);

  const res5 = runCli(["search", "--help"]);
  assert.equal(res5.status, 0);
  assert.match(res5.stdout, /Commands:/);
});

test("CLI: exits with code 2 on unknown command", () => {
  const res = runCli(["non-existent-cmd"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown command: "non-existent-cmd"/);
});

test("CLI: search exits with code 1 on missing term", () => {
  const res = runCli(["search"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: re-tool search <term>/);
});

test("CLI: search executes and formats output as JSON", () => {
  const res = runCli(["search", "token", "--file", "sample.js", "--json"]);
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.command, "search");
  assert.equal(data.term, "token");
  assert.ok(data.totalMatches >= 1);
  assert.ok(Array.isArray(data.matches));
});

test("CLI: pos displays window around offset as JSON", () => {
  const res = runCli(["pos", "10", "--file", "sample.js", "--json"]);
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.command, "pos");
  assert.equal(data.offset, 10);
  assert.ok(typeof data.slice === "string");
});

test("CLI: line displays line content as JSON", () => {
  const res = runCli(["line", "1", "--file", "sample.js", "--json"]);
  assert.equal(res.status, 0);
  const data = JSON.parse(res.stdout);
  assert.equal(data.command, "line");
  assert.equal(data.lineNumber, 1);
  assert.ok(typeof data.content === "string");
});

test("CLI: extract captures groups as JSON array", () => {
  const res = runCli([
    "extract",
    "secret-([a-z]+)-123",
    "--file",
    "sample.js",
    "--json",
  ]);
  assert.equal(res.status, 0);
  const list = JSON.parse(res.stdout);
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
});

test("CLI: scan produces JSON report@2", () => {
  const res = runCli(["scan", "fixtures/webpack.min.js"]);
  assert.equal(res.status, 0);
  const report = JSON.parse(res.stdout);
  assert.equal(report.schema, "re-tool/report@2");
  assert.ok(report.summary.totalStrings > 0);
});

test("CLI: asar lists archive contents as JSON", () => {
  const res = runCli(["asar", "fixtures/demo-app.asar", "--json"]);
  assert.equal(res.status, 0);
  const report = JSON.parse(res.stdout);
  assert.equal(report.command, "asar");
  assert.ok(report.totalFiles > 0);
});

test("CLI: doctor produces diagnostic JSON", () => {
  const res = runCli(["doctor", "--json"]);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.schema, "re-tool/doctor@1");
  assert.ok(doc.node.version);
});

test("CLI: web with --download saves discovered files to directory", async () => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (u.pathname === "/bundle.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end("console.log('downloaded bundle');");
      return;
    }
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><script src=\"/bundle.js\"></script></head><body>OK</body></html>");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-web-download-"));

  try {
    const res = await runCliAsync(["web", url, "--download", tmpDir]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Downloaded \d+ file\(s\)/);

    const html = await fs.readFile(path.join(tmpDir, "index.html"), "utf8");
    assert.match(html, /bundle\.js/);

    const bundle = await fs.readFile(path.join(tmpDir, "bundle.js"), "utf8");
    assert.equal(bundle, "console.log('downloaded bundle');");
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: unpack exits with code 1 on missing target", () => {
  const res = runCli(["unpack"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: re-tool unpack/);
});

test("CLI: unpack restores original source files from .map to directory", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-unpack-"));
  const outDir = path.join(tmpDir, "unpacked");

  try {
    const mapFile = path.join(tmpDir, "app.js.map");
    const mapContent = {
      version: 3,
      sources: ["webpack:///src/components/Button.tsx", "webpack:///src/index.ts"],
      sourcesContent: [
        "export const Button = () => '<button>Click</button>';",
        "import { Button } from './components/Button'; console.log(Button());",
      ],
    };
    await fs.writeFile(mapFile, JSON.stringify(mapContent), "utf8");

    const res = runCli(["unpack", mapFile, "-o", outDir]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Restored 2 original file\(s\)/);

    const btn = await fs.readFile(path.join(outDir, "src/components/Button.tsx"), "utf8");
    assert.match(btn, /export const Button/);

    const idx = await fs.readFile(path.join(outDir, "src/index.ts"), "utf8");
    assert.match(idx, /import \{ Button \}/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: unpack with --json outputs structured report", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-unpack-json-"));
  const outDir = path.join(tmpDir, "unpacked");

  try {
    const mapFile = path.join(tmpDir, "test.js.map");
    const mapContent = {
      version: 3,
      sources: ["src/config.json"],
      sourcesContent: ['{"api": "https://api.example.com"}'],
    };
    await fs.writeFile(mapFile, JSON.stringify(mapContent), "utf8");

    const res = runCli(["unpack", mapFile, "-o", outDir, "--json"]);
    assert.equal(res.status, 0);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.filesRestored, 1);
    assert.equal(parsed.targetType, "map");
    assert.deepEqual(parsed.entries, ["src/config.json"]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: audit exits with code 1 on missing target", () => {
  const res = runCli(["audit"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: re-tool audit/);
});

test("CLI: audit executes on local file and prints findings", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-audit-"));
  const appFile = path.join(tmpDir, "app.js");

  try {
    const code = `
      const win = new BrowserWindow({
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false
        }
      });
      const key = "AKIA1111111111111111";
    `;
    await fs.writeFile(appFile, code, "utf8");

    const res = runCli(["audit", appFile]);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Security audit of/);
    assert.match(res.stdout, /\[CRITICAL\] Dangerous nodeIntegration enabled/);
    assert.match(res.stdout, /\[CRITICAL\] contextIsolation is disabled/);
    assert.match(res.stdout, /\[CRITICAL\] Hardcoded AWS Access Key/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: audit with --json and --out writes report", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-audit-json-"));
  const appFile = path.join(tmpDir, "sample.js");
  const outFile = path.join(tmpDir, "audit.json");

  try {
    const code = 'const x = { webSecurity: false };';
    await fs.writeFile(appFile, code, "utf8");

    const res = runCli(["audit", appFile, "--json", "-o", outFile]);
    assert.equal(res.status, 0);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.schema, "re-tool/audit-report@1");
    assert.ok(parsed.findings.some((f) => f.id === "electron-web-security-disabled"));

    const saved = JSON.parse(await fs.readFile(outFile, "utf8"));
    assert.equal(saved.schema, "re-tool/audit-report@1");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: patch exits with code 1 on missing target", () => {
  const res = runCli(["patch"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: re-tool patch/);
});

test("CLI: patch packs a directory into .asar with --out", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-patch-pack-"));
  const srcDir = path.join(tmpDir, "src");
  const asarPath = path.join(tmpDir, "app.asar");

  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'console.log("hello");');
    await fs.writeFile(path.join(srcDir, "config.json"), '{"env":"test"}');

    const res = runCli(["patch", srcDir, "-o", asarPath, "--json"]);
    assert.equal(res.status, 0);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.command, "patch");
    assert.equal(parsed.action, "pack");
    assert.equal(parsed.totalFiles, 2);

    // Verify it can be listed by asar command
    const asarListRes = runCli(["asar", asarPath, "--json"]);
    assert.equal(asarListRes.status, 0);
    const asarJson = JSON.parse(asarListRes.stdout);
    assert.equal(asarJson.entries.length, 2);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: patch modifies an existing .asar with text replacement and --replace file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-patch-edit-"));
  const srcDir = path.join(tmpDir, "src");
  const asarPath = path.join(tmpDir, "app.asar");
  const newHelper = path.join(tmpDir, "helper.js");

  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, "main.js"), 'const isTrial = true;\nrun();');
    await fs.writeFile(newHelper, 'module.exports = { patch: true };');

    // Pack first
    runCli(["patch", srcDir, "-o", asarPath]);

    // Now patch in-place: search/replace in main.js and add helper.js
    const patchRes = runCli([
      "patch",
      asarPath,
      "-f",
      "main.js",
      "-s",
      "isTrial = true",
      "--replace-text",
      "isTrial = false",
      "--replace",
      `lib/helper.js=${newHelper}`,
      "--json",
    ]);

    assert.equal(patchRes.status, 0);
    const patchJson = JSON.parse(patchRes.stdout);
    assert.equal(patchJson.action, "patch");
    assert.deepEqual(patchJson.modified, ["main.js"]);
    assert.deepEqual(patchJson.added, ["lib/helper.js"]);
    assert.ok(patchJson.backupPath);

    // Check backup exists
    assert.equal(await fs.stat(patchJson.backupPath).then(() => true).catch(() => false), true);

    // Extract main.js to verify content
    const extractDir = path.join(tmpDir, "extracted");
    runCli(["asar", asarPath, "--extract", "-o", extractDir]);
    const extractedMain = await fs.readFile(path.join(extractDir, "main.js"), "utf8");
    assert.match(extractedMain, /isTrial = false/);
    const extractedHelper = await fs.readFile(path.join(extractDir, "lib/helper.js"), "utf8");
    assert.match(extractedHelper, /module\.exports = \{ patch: true \};/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: decode exits with code 1 on missing input", () => {
  const res = runCli(["decode"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage: re-tool decode/);
});

test("CLI: decode auto-detects base64 and formats JSON", () => {
  const res = runCli(["decode", "c2VjcmV0LXRva2VuLTEyMw==", "--json"]);
  assert.equal(res.status, 0);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.command, "decode");
  assert.equal(parsed.detected, "base64");
  assert.equal(parsed.decoded, "secret-token-123");
  assert.equal(parsed.isText, true);
});

test("CLI: decode auto-detects hex and outputs text", () => {
  const res = runCli(["decode", "48656c6c6f20576f726c64"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Decoded as Hexadecimal/);
  assert.match(res.stdout, /Hello World/);
});

test("CLI: decode reads input from file with -f", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-cli-decode-"));
  const tokenFile = path.join(tmpDir, "token.b64");
  try {
    await fs.writeFile(tokenFile, "YXBpLWtleS05OTk=");
    const res = runCli(["decode", "-f", tokenFile, "--json"]);
    assert.equal(res.status, 0);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.detected, "base64");
    assert.equal(parsed.decoded, "api-key-999");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("CLI: decode with --as forces specific decoding", () => {
  const res = runCli(["decode", "deadbeef", "--as", "hex", "--json"]);
  assert.equal(res.status, 0);

  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.detected, "hex");
  assert.equal(parsed.bytes, 4);
});
