import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  optValue,
  hasFlag,
  parseNonNegativeInt,
} from "../dist/args.js";

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

test("CLI: prints help with code 0 on 'help' or empty args", () => {
  const res1 = runCli(["help"]);
  assert.equal(res1.status, 0);
  assert.match(res1.stdout, /Commands:/);
  assert.match(res1.stdout, /search <term>/);

  const res2 = runCli([]);
  assert.equal(res2.status, 0);
  assert.match(res2.stdout, /re-tool — reverse engineering assistant/);
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
