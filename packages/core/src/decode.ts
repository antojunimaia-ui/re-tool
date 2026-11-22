// Encoding detection and decoding utilities for re-tool decode command.
import { ToolError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecodeEncoding =
  | "base64"
  | "base64url"
  | "hex"
  | "hex-escaped"
  | "unicode-escaped"
  | "url-encoded"
  | "html-entity"
  | "jwt";

export interface DecodeCandidate {
  encoding: DecodeEncoding;
  /** Raw decoded bytes. */
  bytes: Buffer;
  /** UTF-8 string if the bytes are valid text, undefined if binary. */
  text?: string;
  /** True when the decoded bytes appear to be printable text. */
  isText: boolean;
  /** Confidence score 0–1. */
  confidence: number;
}

export interface DecodeResult {
  schema: "re-tool/decode@1";
  input: string;
  /** Best-match decoding (highest confidence). */
  detected: DecodeEncoding;
  /** All successful decodings ordered by confidence. */
  candidates: DecodeCandidate[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": "\u00a0",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&euro;": "€",
  "&pound;": "£",
  "&yen;": "¥",
  "&cent;": "¢",
  "&mdash;": "—",
  "&ndash;": "–",
  "&laquo;": "«",
  "&raquo;": "»",
};

function isPrintableUtf8(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  try {
    const str = buf.toString("utf8");
    // Reject if round-trip is lossy (replacement chars)
    if (str.includes("\uFFFD")) return false;
    // Count control characters (allow tab/newline/cr)
    let controls = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 32 && c !== 9 && c !== 10 && c !== 13) controls++;
    }
    return controls / str.length < 0.1;
  } catch {
    return false;
  }
}

function hexDump(buf: Buffer, maxBytes = 256): string {
  const slice = buf.subarray(0, maxBytes);
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const row = slice.subarray(i, i + 16);
    const hex = Array.from(row)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const ascii = Array.from(row)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > maxBytes) {
    lines.push(`... (${buf.length - maxBytes} more bytes)`);
  }
  return lines.join("\n");
}

function candidate(
  encoding: DecodeEncoding,
  bytes: Buffer,
  confidence: number,
): DecodeCandidate {
  const isText = isPrintableUtf8(bytes);
  return {
    encoding,
    bytes,
    text: isText ? bytes.toString("utf8") : undefined,
    isText,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Individual decoders
// ---------------------------------------------------------------------------

function tryBase64(input: string): DecodeCandidate | null {
  const trimmed = input.trim();
  // Do not treat multi-word space-separated text as base64
  if (/\s/.test(trimmed) && !/[\r\n]/.test(trimmed)) {
    return null;
  }

  const clean = trimmed.replace(/[\r\n\t ]/g, "");
  if (clean.length === 0) return null;

  // Standard base64 charset
  const isStdBase64 = /^[A-Za-z0-9+/]+=*$/.test(clean);
  if (!isStdBase64) return null;
  if (clean.length % 4 !== 0) return null;

  try {
    const buf = Buffer.from(clean, "base64");
    if (buf.length === 0) return null;
    const roundTrip = buf.toString("base64");
    // Allow slight padding difference
    const normalizedInput = clean.replace(/=+$/, "");
    const normalizedRt = roundTrip.replace(/=+$/, "");
    if (normalizedRt !== normalizedInput) return null;

    const isText = isPrintableUtf8(buf);
    const hasPunctuation = clean.includes("+") || clean.includes("/") || clean.includes("=");

    // If it's pure alphanumeric with no punctuation and produces binary garbage, reject
    if (!isText && !hasPunctuation) {
      return null;
    }

    let confidence = 0.5;
    if (isText && hasPunctuation) confidence = 0.95;
    else if (isText) confidence = 0.85;
    else if (hasPunctuation) confidence = 0.75;

    return {
      encoding: "base64",
      bytes: buf,
      text: isText ? buf.toString("utf8") : undefined,
      isText,
      confidence,
    };
  } catch {
    return null;
  }
}

function tryBase64Url(input: string): DecodeCandidate | null {
  const trimmed = input.trim();
  if (/\s/.test(trimmed) && !/[\r\n]/.test(trimmed)) {
    return null;
  }

  const original = trimmed.replace(/[\r\n\t ]/g, "");
  if (original.length === 0) return null;
  if (original.length % 4 === 1) return null; // Invalid base64 length

  const isUrlSafe = /^[A-Za-z0-9\-_]+=*$/.test(original);
  if (!isUrlSafe) return null;

  const hasUrlChars = original.includes("-") || original.includes("_");
  const unpadded = original.length % 4 !== 0 && !original.endsWith("=");

  // Must have URL chars (- or _) OR be unpadded base64
  if (!hasUrlChars && !unpadded) return null;

  const clean = original.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (clean.length % 4)) % 4;
  const padded = clean + "=".repeat(pad);

  try {
    const buf = Buffer.from(padded, "base64");
    if (buf.length === 0) return null;

    const isText = isPrintableUtf8(buf);
    if (!isText && !hasUrlChars) {
      return null;
    }

    return {
      encoding: "base64url",
      bytes: buf,
      text: isText ? buf.toString("utf8") : undefined,
      isText,
      confidence: hasUrlChars ? 0.92 : (isText ? 0.82 : 0.6),
    };
  } catch {
    return null;
  }
}

function tryHex(input: string): DecodeCandidate | null {
  const trimmed = input.trim();
  // Support hex with spaces/colons/dashes: "48 65 6c 6c 6f" or "48:65:6c:6c:6f"
  let clean = trimmed;
  const hasPrefix = /^0x/i.test(clean);
  if (hasPrefix) clean = clean.slice(2);
  else if (/^[0-9a-fA-F]{2}([ :\-][0-9a-fA-F]{2})+$/.test(clean)) {
    clean = clean.replace(/[ :\-]/g, "");
  }

  clean = clean.replace(/\s/g, "");
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  if (clean.length % 2 !== 0) return null;
  if (clean.length < 2) return null;

  const buf = Buffer.from(clean, "hex");
  const isText = isPrintableUtf8(buf);

  let confidence = 0.6;
  if (hasPrefix && isText) confidence = 0.95;
  else if (hasPrefix) confidence = 0.9;
  else if (isText && clean.length >= 8) confidence = 0.88;
  else if (isText) confidence = 0.7;
  else if (clean.length >= 8) confidence = 0.65;

  return {
    encoding: "hex",
    bytes: buf,
    text: isText ? buf.toString("utf8") : undefined,
    isText,
    confidence,
  };
}

function tryHexEscaped(input: string): DecodeCandidate | null {
  // Matches \x41 or \x{41} sequences
  if (!/\\x[0-9a-fA-F]{2}/.test(input)) return null;

  const bytes: number[] = [];
  const pattern = /\\x\{?([0-9a-fA-F]{1,4})\}?/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let hasNonEscaped = false;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) hasNonEscaped = true;
    const code = parseInt(match[1], 16);
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      // Multi-byte unicode code point → UTF-8 encode
      const encoded = Buffer.from(String.fromCodePoint(code), "utf8");
      bytes.push(...encoded);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.length) hasNonEscaped = true;
  if (bytes.length === 0) return null;

  const buf = Buffer.from(bytes);
  const confidence = hasNonEscaped ? 0.75 : 0.9;
  return candidate("hex-escaped", buf, confidence);
}

function tryUnicodeEscaped(input: string): DecodeCandidate | null {
  // Matches \uXXXX or \u{XXXXX}
  if (!/\\u[0-9a-fA-F]/.test(input)) return null;

  const chars: string[] = [];
  const pattern = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let nonEscaped = "";

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      nonEscaped += input.slice(lastIndex, match.index);
    }
    const hex = match[1] ?? match[2];
    const code = parseInt(hex, 16);
    chars.push(String.fromCodePoint(code));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.length) nonEscaped += input.slice(lastIndex);
  if (chars.length === 0) return null;

  const decoded = nonEscaped + chars.join("");
  const buf = Buffer.from(decoded, "utf8");
  const hasNonEscaped = nonEscaped.trim().length > 0;
  const confidence = hasNonEscaped ? 0.75 : 0.9;
  return candidate("unicode-escaped", buf, confidence);
}

function tryUrlEncoded(input: string): DecodeCandidate | null {
  if (!input.includes("%")) return null;
  if (!/%([\dA-Fa-f]{2})/.test(input)) return null;

  try {
    const decoded = decodeURIComponent(input);
    if (decoded === input) return null; // Nothing was decoded
    const buf = Buffer.from(decoded, "utf8");
    // Confidence based on how much of the string was encoded
    const encodedCount = (input.match(/%[\dA-Fa-f]{2}/g) ?? []).length;
    const confidence = Math.min(0.9, 0.5 + encodedCount * 0.1);
    return candidate("url-encoded", buf, confidence);
  } catch {
    return null;
  }
}

function tryHtmlEntity(input: string): DecodeCandidate | null {
  if (!input.includes("&")) return null;
  if (!/&[a-zA-Z#][a-zA-Z0-9]*;/.test(input)) return null;

  let decoded = input;

  // Named entities
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    decoded = decoded.replaceAll(entity, char);
  }

  // Numeric decimal: &#65;
  decoded = decoded.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));

  // Numeric hex: &#x41;
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
    String.fromCodePoint(parseInt(h, 16)),
  );

  if (decoded === input) return null;

  const buf = Buffer.from(decoded, "utf8");
  const entityCount = (input.match(/&[a-zA-Z#][a-zA-Z0-9]*;/g) ?? []).length;
  const confidence = Math.min(0.9, 0.5 + entityCount * 0.15);
  return candidate("html-entity", buf, confidence);
}

interface JwtPayload {
  header: Record<string, unknown>;
  payload: Record<string, unknown> | string;
}

function tryJwt(input: string): DecodeCandidate | null {
  const clean = input.trim();
  const parts = clean.split(".");
  if (parts.length !== 3) return null;

  const decodeJwtPart = (part: string): unknown => {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (padded.length % 4)) % 4;
    const buf = Buffer.from(padded + "=".repeat(pad), "base64");
    return JSON.parse(buf.toString("utf8"));
  };

  try {
    const header = decodeJwtPart(parts[0]) as Record<string, unknown>;
    if (typeof header !== "object" || !header.alg) return null;

    let payload: Record<string, unknown> | string;
    try {
      payload = decodeJwtPart(parts[1]) as Record<string, unknown>;
    } catch {
      // Payload might be non-JSON for some JWTs
      const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const pad = (4 - (padded.length % 4)) % 4;
      payload = Buffer.from(padded + "=".repeat(pad), "base64").toString("utf8");
    }

    const result: JwtPayload = { header, payload };
    const text = JSON.stringify(result, null, 2);
    const buf = Buffer.from(text, "utf8");
    return candidate("jwt", buf, 0.98);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-detection
// ---------------------------------------------------------------------------

const DECODERS: Array<(input: string) => DecodeCandidate | null> = [
  tryJwt,          // Most specific first
  tryHexEscaped,
  tryUnicodeEscaped,
  tryUrlEncoded,
  tryHtmlEntity,
  tryBase64Url,
  tryHex,
  tryBase64,
];

const ENCODING_NAMES: Record<DecodeEncoding, string> = {
  base64: "Base64",
  base64url: "Base64 URL-safe",
  hex: "Hexadecimal",
  "hex-escaped": "Hex-escaped (\\xNN)",
  "unicode-escaped": "Unicode-escaped (\\uNNNN)",
  "url-encoded": "URL-encoded (%XX)",
  "html-entity": "HTML entities",
  jwt: "JWT (JSON Web Token)",
};

export function getEncodingLabel(enc: DecodeEncoding): string {
  return ENCODING_NAMES[enc] ?? enc;
}

export function decodeInput(input: string): DecodeResult {
  if (!input || input.trim().length === 0) {
    throw new ToolError("Input is empty. Provide a string to decode.");
  }

  const candidates: DecodeCandidate[] = [];

  for (const decoder of DECODERS) {
    try {
      const result = decoder(input);
      if (result) candidates.push(result);
    } catch {
      // Skip failed decoders
    }
  }

  if (candidates.length === 0) {
    throw new ToolError(
      "Could not detect a known encoding. Use --as <encoding> to force one.\n" +
        "Supported: base64, base64url, hex, hex-escaped, unicode-escaped, url-encoded, html-entity, jwt",
    );
  }

  // Sort by confidence desc
  candidates.sort((a, b) => b.confidence - a.confidence);

  return {
    schema: "re-tool/decode@1",
    input,
    detected: candidates[0].encoding,
    candidates,
  };
}

export function decodeAs(input: string, encoding: DecodeEncoding): DecodeCandidate {
  const decoderMap: Record<DecodeEncoding, (s: string) => DecodeCandidate | null> = {
    base64: tryBase64,
    base64url: tryBase64Url,
    hex: tryHex,
    "hex-escaped": tryHexEscaped,
    "unicode-escaped": tryUnicodeEscaped,
    "url-encoded": tryUrlEncoded,
    "html-entity": tryHtmlEntity,
    jwt: tryJwt,
  };

  const decoder = decoderMap[encoding];
  if (!decoder) {
    throw new ToolError(
      `Unknown encoding: "${encoding}". Supported: base64, base64url, hex, hex-escaped, unicode-escaped, url-encoded, html-entity, jwt`,
    );
  }

  const result = decoder(input);
  if (!result) {
    throw new ToolError(`Input does not appear to be valid ${getEncodingLabel(encoding)}.`);
  }

  return result;
}

export { hexDump };
