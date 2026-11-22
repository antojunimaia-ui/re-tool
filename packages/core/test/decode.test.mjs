import { test } from "node:test";
import assert from "node:assert/strict";

import { decodeInput, decodeAs, ToolError } from "../dist/index.js";

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

test("decodeInput detects base64", () => {
  const result = decodeInput("c2VjcmV0LXRva2VuLTEyMw==");
  assert.equal(result.detected, "base64");
  assert.equal(result.candidates[0].text, "secret-token-123");
});

test("decodeInput detects base64url with - and _", () => {
  const encoded = Buffer.from("hello+world").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  const result = decodeInput(encoded);
  // base64url or base64 both acceptable — decoded text must match
  const best = result.candidates[0];
  assert.ok(best.isText);
  assert.equal(best.text, "hello+world");
});

test("decodeInput detects hex string", () => {
  const result = decodeInput("48656c6c6f20576f726c64");
  assert.equal(result.detected, "hex");
  assert.equal(result.candidates[0].text, "Hello World");
});

test("decodeInput detects hex-escaped \\xNN sequences", () => {
  const result = decodeInput("\\x48\\x65\\x6c\\x6c\\x6f");
  assert.equal(result.detected, "hex-escaped");
  assert.equal(result.candidates[0].text, "Hello");
});

test("decodeInput detects unicode-escaped \\uNNNN sequences", () => {
  const result = decodeInput("\\u0048\\u0065\\u006c\\u006c\\u006f");
  assert.equal(result.detected, "unicode-escaped");
  assert.equal(result.candidates[0].text, "Hello");
});

test("decodeInput detects url-encoded strings", () => {
  const result = decodeInput("hello%20world%21");
  assert.equal(result.detected, "url-encoded");
  assert.equal(result.candidates[0].text, "hello world!");
});

test("decodeInput detects HTML entities", () => {
  const result = decodeInput("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  assert.equal(result.detected, "html-entity");
  assert.ok(result.candidates[0].text?.includes("<script>"));
});

test("decodeInput detects JWT and decodes header+payload", () => {
  // Build a minimal JWT (not signed, just for format testing)
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "1234567890", name: "John Doe" })).toString("base64url");
  const jwt = `${header}.${payload}.fakesig`;

  const result = decodeInput(jwt);
  assert.equal(result.detected, "jwt");
  const text = result.candidates[0].text;
  const parsed = JSON.parse(text);
  assert.equal(parsed.header.alg, "HS256");
  assert.equal(parsed.payload.name, "John Doe");
});

test("decodeInput returns multiple candidates ordered by confidence", () => {
  // A pure hex string is also a valid base64 candidate but hex should win
  const result = decodeInput("deadbeef");
  assert.ok(result.candidates.length >= 1);
  // Candidates are ordered descending by confidence
  for (let i = 1; i < result.candidates.length; i++) {
    assert.ok(result.candidates[i - 1].confidence >= result.candidates[i].confidence);
  }
});

test("decodeInput throws ToolError on empty input", () => {
  assert.throws(() => decodeInput(""), (err) => err instanceof ToolError);
  assert.throws(() => decodeInput("   "), (err) => err instanceof ToolError);
});

test("decodeInput throws ToolError on unrecognized input", () => {
  assert.throws(
    () => decodeInput("this is just plain english text with no encoding"),
    (err) => err instanceof ToolError,
  );
});

// ---------------------------------------------------------------------------
// Forced encoding (--as)
// ---------------------------------------------------------------------------

test("decodeAs base64 decodes correctly", () => {
  const c = decodeAs("SGVsbG8gV29ybGQ=", "base64");
  assert.equal(c.text, "Hello World");
  assert.equal(c.isText, true);
});

test("decodeAs hex decodes correctly", () => {
  const c = decodeAs("48656c6c6f", "hex");
  assert.equal(c.text, "Hello");
});

test("decodeAs url-encoded decodes correctly", () => {
  const c = decodeAs("caf%C3%A9", "url-encoded");
  assert.equal(c.text, "café");
});

test("decodeAs throws ToolError for invalid input", () => {
  assert.throws(
    () => decodeAs("not-base64!!!", "base64"),
    (err) => err instanceof ToolError,
  );
});

test("decodeAs throws ToolError for unknown encoding", () => {
  assert.throws(
    () => decodeAs("hello", /** @type {any} */ ("rot13")),
    (err) => err instanceof ToolError,
  );
});

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

test("decodeInput marks binary output correctly (isText=false)", () => {
  // PNG magic bytes in hex
  const pngHex = "89504e470d0a1a0a";
  const result = decodeInput(pngHex);
  const hexCandidate = result.candidates.find((c) => c.encoding === "hex");
  assert.ok(hexCandidate);
  assert.equal(hexCandidate.isText, false);
  assert.equal(hexCandidate.text, undefined);
});
