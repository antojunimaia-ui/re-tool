import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  normalizeEol,
  readSource,
  findMatches,
  windowAt,
  readLine,
  extractCaptures,
  ToolError,
} from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const sampleFile = path.join(repoRoot, "sample.js");

test("normalizeEol unifies CRLF/CR to LF", () => {
  assert.equal(normalizeEol("a\r\nb\rc"), "a\nb\nc");
});

test("readSource reads the sample file and exposes lines", async () => {
  const source = await readSource(sampleFile);
  assert.equal(source.path, sampleFile);
  assert.ok(source.content.includes("sample.js"));
  assert.ok(source.lines.length > 0);
  assert.equal(source.lines.join("\n"), source.content);
});

test("readSource throws ToolError for missing file", async () => {
  await assert.rejects(
    readSource(path.join(repoRoot, "nao-existe.js")),
    (err) => err instanceof ToolError && err.message.includes("not found"),
  );
});

test("findMatches finds all occurrences and respects the limit", async () => {
  const source = await readSource(sampleFile);
  const result = findMatches(source, "token");
  assert.equal(result.totalMatches, 9);
  assert.equal(result.shown, 5); // default limit
  assert.equal(result.truncated, true);
  assert.equal(result.regex, false);
  assert.equal(result.matches.length, 5);
  assert.equal(result.matches[0].match, "token");
  assert.equal(result.matches[0].index, source.content.indexOf("token"));
  assert.equal(result.matches[0].line, 3);
});

test("findMatches with larger limit returns everything without truncation", async () => {
  const source = await readSource(sampleFile);
  const result = findMatches(source, "token", { limit: 100 });
  assert.equal(result.totalMatches, 9);
  assert.equal(result.shown, 9);
  assert.equal(result.truncated, false);
});

test("findMatches regex \"\\d+\" locates all digits", async () => {
  const source = await readSource(sampleFile);
  const result = findMatches(source, "\\d+", { regex: true, limit: 100 });
  assert.equal(result.totalMatches, 18);
  assert.equal(result.regex, true);
  assert.ok(result.matches.every((m) => /^\d+$/.test(m.match)));
});

test("findMatches with no matches returns an empty list", async () => {
  const source = await readSource(sampleFile);
  const result = findMatches(source, "zzz-inexistente");
  assert.equal(result.totalMatches, 0);
  assert.equal(result.matches.length, 0);
  assert.equal(result.truncated, false);
});

test("findMatches rejects empty term", async () => {
  const source = await readSource(sampleFile);
  assert.throws(() => findMatches(source, ""), (err) => err instanceof ToolError);
});

test("findMatches rejects invalid regex", async () => {
  const source = await readSource(sampleFile);
  assert.throws(
    () => findMatches(source, "([a-z", { regex: true }),
    (err) => err instanceof ToolError && /invalid/i.test(err.message),
  );
});

test("windowAt clips a window around the offset", async () => {
  const source = await readSource(sampleFile);
  const result = windowAt(source, 120);
  assert.equal(result.start, 20); // 120 - 100 (before padrão)
  assert.equal(result.end, source.content.length); // 120 + 400 > tamanho do arquivo
  assert.equal(result.slice, source.content.slice(20, source.content.length));
});

test("windowAt with offset 0 starts at the beginning", async () => {
  const source = await readSource(sampleFile);
  const result = windowAt(source, 0);
  assert.equal(result.start, 0);
  assert.equal(result.slice, source.content.slice(0, 400));
});

test("readLine returns the requested line", async () => {
  const source = await readSource(sampleFile);
  const result = readLine(source, 1);
  assert.equal(result.lineNumber, 1);
  assert.ok(result.content.startsWith("// sample.js"));
  assert.equal(result.truncated, false);
});

test("readLine throws for invalid or out-of-range line number", async () => {
  const source = await readSource(sampleFile);
  assert.throws(() => readLine(source, 0), (err) => err instanceof ToolError);
  assert.throws(() => readLine(source, 999), (err) => err instanceof ToolError);
});

test("readLine truncates content larger than the max", async () => {
  const source = await readSource(sampleFile);
  const result = readLine(source, 1, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.content.length, 10);
});

test("findMatches supports case-insensitive literal search", async () => {
  const source = await readSource(sampleFile);
  const result = findMatches(source, "TOKEN", { ignoreCase: true, limit: 100 });
  const expected = (source.content.match(/token/gi) || []).length;
  assert.equal(result.totalMatches, expected);
  assert.equal(result.ignoreCase, true);
  assert.ok(result.matches.every((m) => m.match.toLowerCase() === "token"));
});

test("findMatches ignoreCase works with the regex flag too", async () => {
  const source = await readSource(sampleFile);
  const result = findMatches(source, "TOKEN_PATTERN", {
    regex: true,
    ignoreCase: true,
    limit: 100,
  });
  assert.ok(result.totalMatches >= 1);
});

test("extractCaptures pulls capture groups", async () => {
  const source = await readSource(sampleFile);
  const res = extractCaptures(source, "secret-([a-z]+)-123");
  assert.equal(res.total, 1);
  assert.deepEqual(res.captures, ["token"]);
  assert.equal(res.truncated, false);
});

test("extractCaptures without group returns full match and enforces limit", () => {
  const content = { path: "x.js", content: "aa bb aa cc", lines: ["aa bb aa cc"] };
  const res = extractCaptures(content, "[a-z]{2}", { limit: 3 });
  assert.equal(res.captures.length, 3);
  assert.equal(res.truncated, true);
  assert.equal(res.total, 4);
});

test("extractCaptures unique removes duplicates", () => {
  const content = { path: "x.js", content: "aa bb aa cc", lines: ["aa bb aa cc"] };
  const res = extractCaptures(content, "[a-z]{2}", { unique: true });
  assert.deepEqual(res.captures, ["aa", "bb", "cc"]);
  assert.equal(res.total, 4);
});
