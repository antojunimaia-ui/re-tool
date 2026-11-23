// Re-tool as a tool-call surface for agent harnesses.
//
// This module exposes re-tool's capabilities as plain "tool call" records —
// { name, description, inputSchema, sideEffects, handler } — ready to be
// registered in a code-agent harness (OpenAI-style function calling, Anthropic
// tools, or a custom schema of the harness's own).
//
// IMPORTANT: every handler calls the core engine directly (the same functions
// the CLI uses). Nothing here spawns the CLI or a subprocess. Results are plain
// JSON-serializable objects — the canonical report schemas (re-tool/report@2,
// re-tool/web-report@1, re-tool/electron-report@1, re-tool/decode@1, …).
//
// The transport/schema mapping is intentionally left to the harness: export the
// canonical `tools` array and map it to whatever shape your agent expects
// (`adaptTools` ships ready-made adapters for OpenAI and Anthropic).
import {
  ToolError,
  readSource,
  findMatches,
  extractCaptures,
  scanSource,
  analyzeAsarApp,
  beautify,
  decodeInput,
  decodeAs,
  getEncodingLabel,
  analyzeWeb,
  auditTarget,
  type DecodeEncoding,
  type DecodeCandidate,
  type AnalyzeWebOptions,
  type AuditSeverity,
} from "re-tool-core";

// ---------------------------------------------------------------------------
// Canonical tool call shape
// ---------------------------------------------------------------------------

export type ToolSideEffect = "readonly" | "network" | "browser" | "mutating";

export interface RetoolTool {
  /** Stable tool name (matches the CLI command it wraps). */
  name: string;
  /** Description for the LLM: when to use it, what it returns. */
  description: string;
  /** JSON Schema (draft-07 style) describing the arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * Side effects the harness can use for permission decisions:
   * - "readonly": touches only the given local file, no mutation
   * - "network": makes outbound HTTP(S) requests
   * - "browser": launches/drives a browser (headless or --connect)
   * - "mutating": can modify or write files
   */
  sideEffects: readonly ToolSideEffect[];
  /**
   * Executes the tool. Returns a plain JSON-serializable value (a canonical
   * report or a plain result object). Throws ToolError on domain errors.
   */
  handler(args: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function str(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

function num(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function bool(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = args[key];
  return typeof v === "boolean" ? v : fallback;
}

function requireArg(args: Record<string, unknown>, key: string, tool: string): string {
  const v = str(args, key);
  if (!v) throw new ToolError(`${tool}: missing required argument "${key}".`);
  return v;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools: RetoolTool[] = [
  {
    name: "search",
    description:
      "Search a file for occurrences of a term (literal or regex) and return each match " +
      "with line, column and surrounding context. Use it to locate code, config keys, " +
      "API calls or suspicious patterns inside a script/bundle.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file to search." },
        term: { type: "string", description: "Literal text or regex to find." },
        regex: { type: "boolean", description: "Treat term as a regular expression. Default: false." },
        ignoreCase: { type: "boolean", description: "Case-insensitive search. Default: false." },
        limit: { type: "integer", minimum: 0, description: "Max matches returned. Default: 5 (0 = unlimited)." },
        context: { type: "integer", minimum: 0, description: "Context characters before/after each match. Default: 400." },
      },
      required: ["file", "term"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "search");
      const term = requireArg(args, "term", "search");
      const source = await readSource(file);
      return findMatches(source, term, {
        regex: bool(args, "regex"),
        ignoreCase: bool(args, "ignoreCase"),
        limit: num(args, "limit", 5),
        context: num(args, "context", 400),
      });
    },
  },

  {
    name: "extract",
    description:
      "Extract regex capture groups from a file (group 1 when present, otherwise the whole " +
      "match). Ideal for harvesting tokens, IDs, URLs or key=value pairs in bulk.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file." },
        pattern: { type: "string", description: "Regular expression with capture groups." },
        unique: { type: "boolean", description: "Drop duplicate captures. Default: false." },
        limit: { type: "integer", minimum: 0, description: "Max captures returned. Default: 1000 (0 = unlimited)." },
      },
      required: ["file", "pattern"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "extract");
      const pattern = requireArg(args, "pattern", "extract");
      const source = await readSource(file);
      return extractCaptures(source, pattern, {
        unique: bool(args, "unique"),
        limit: num(args, "limit", 1000),
      });
    },
  },

  {
    name: "scan",
    description:
      "Run the full analysis pipeline over a JavaScript file: detect bundler/minification, " +
      "extract strings (with offsets, entropy, encodings), inspect webpack modules, source " +
      "maps and obfuscators. Returns a re-tool/report@2 report. Use for static analysis of " +
      "a bundle or script.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the JS file (or .asar entry view)." },
        minLength: { type: "integer", minimum: 1, description: "Ignore strings shorter than this. Default: 4." },
        limit: { type: "integer", minimum: 1, description: "Max strings in the report. Default: 750." },
      },
      required: ["file"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "scan");
      const source = await readSource(file);
      return scanSource(source, {
        minLength: num(args, "minLength", 4),
        limit: num(args, "limit", 750),
      });
    },
  },

  {
    name: "asar",
    description:
      "Analyze an Electron .asar archive: list entries and scan every embedded JS file " +
      "(strings, webpack, obfuscators, source maps). Returns a re-tool/electron-report@1 " +
      "report. Use for Electron app analysis.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the .asar archive." },
        minLength: { type: "integer", minimum: 1, description: "Ignore strings shorter than this. Default: 4." },
        limit: { type: "integer", minimum: 1, description: "Max strings per file in the report. Default: 50." },
        maxFiles: { type: "integer", minimum: 1, description: "Max JS entries analyzed. Default: 300." },
      },
      required: ["file"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "asar");
      return analyzeAsarApp(file, {
        minLength: num(args, "minLength", 4),
        limit: num(args, "limit", 50),
        maxFiles: num(args, "maxFiles", 300),
      });
    },
  },

  {
    name: "beautify",
    description:
      "Reformat (de-minify) a JavaScript file with Prettier. Returns the pretty code and " +
      "byte counts. Use to make a minified bundle readable before deeper analysis.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the JS file." },
      },
      required: ["file"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "beautify");
      const source = await readSource(file);
      const result = await beautify(source.content);
      return {
        schema: "re-tool/beautify@1",
        file: source.path,
        ok: result.ok,
        inputBytes: source.content.length,
        outputBytes: result.code.length,
        code: result.ok ? result.code : undefined,
        error: result.ok ? undefined : result.error,
      };
    },
  },

  {
    name: "decode",
    description:
      "Auto-detect and decode an encoded string (base64, base64url, hex, escapes, URL, " +
      "HTML entities, JWT). With `encoding` set, decode using that specific encoding. " +
      "Returns the detected encoding, the decoded text/hex, and all candidates.",
    inputSchema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The encoded string to decode." },
        encoding: {
          type: "string",
          enum: ["base64", "base64url", "hex", "hex-escaped", "unicode-escaped", "url-encoded", "html-entity", "jwt"],
          description: "Force a specific encoding instead of auto-detecting.",
        },
        all: { type: "boolean", description: "Include every decoding candidate. Default: false." },
      },
      required: ["input"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const input = requireArg(args, "input", "decode");
      const forced = str(args, "encoding");
      let candidates: DecodeCandidate[];
      let detected: DecodeEncoding;

      if (forced) {
        const c = decodeAs(input, forced as DecodeEncoding);
        candidates = [c];
        detected = c.encoding;
      } else {
        const res = decodeInput(input);
        candidates = res.candidates;
        detected = res.detected;
      }

      const primary = candidates[0];
      const toJson = (c: DecodeCandidate) => ({
        encoding: c.encoding,
        label: getEncodingLabel(c.encoding),
        isText: c.isText,
        decoded: c.isText ? c.text : undefined,
        hex: c.bytes.toString("hex"),
        bytes: c.bytes.length,
        confidence: c.confidence,
      });

      return {
        schema: "re-tool/decode@1",
        input,
        detected,
        label: getEncodingLabel(detected),
        isText: primary.isText,
        decoded: primary.isText ? primary.text : undefined,
        hex: primary.bytes.toString("hex"),
        bytes: primary.bytes.length,
        confidence: primary.confidence,
        candidates: bool(args, "all") ? candidates.map(toJson) : undefined,
      };
    },
  },

  {
    name: "web",
    description:
      "Analyze a live website: fetch HTML + JS bundles, detect frameworks, endpoints, " +
      "routes, keys and feature flags. Returns a re-tool/web-report@1 report. Optionally " +
      "use a real browser (browser=true) to execute JavaScript, capture XHR/WebSocket " +
      "activity, cookies and storage. `connect` drives the user's own browser (with its " +
      "real profile/cookies) via CDP — use only on authorized targets.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The site URL (https://…)." },
        browser: { type: "boolean", description: "Capture with a headless Chrome/Edge over CDP. Default: false." },
        connect: { type: "string", description: "CDP endpoint of an already-running browser (http://127.0.0.1:9222 or ws://…). Implies browser." },
        headed: { type: "boolean", description: "Show a real browser window (helps with bot challenges)." },
        settleMs: { type: "integer", minimum: 0, description: "Extra wait after load in browser mode, ms. Default: 1200." },
        watchSeconds: { type: "integer", minimum: 0, description: "Keep observing the page this many seconds and record runtime requests/WebSockets. Default: 0." },
        challengeWaitMs: { type: "integer", minimum: 0, description: "Extra wait for a detected challenge to clear, ms." },
        allowChallenge: { type: "boolean", description: "Keep the challenge page in the report instead of failing." },
        maxScripts: { type: "integer", minimum: 0, description: "Max scripts downloaded and analyzed. Default: 40 (0 = no limit)." },
        timeoutMs: { type: "integer", minimum: 1, description: "Per-request timeout, ms. Default: 15000." },
        userAgent: { type: "string", description: "Override the User-Agent header." },
        cookie: { type: "string", description: "Cookie header sent with every request (e.g. \"session=abc\")." },
        ignoreRobots: { type: "boolean", description: "Skip the robots.txt check (authorized targets only)." },
        minLength: { type: "integer", minimum: 1, description: "Ignore strings shorter than this. Default: 4." },
        limit: { type: "integer", minimum: 1, description: "Max strings per script in the report. Default: 50." },
        maxEndpoints: { type: "integer", minimum: 1, description: "Max endpoints in the report. Default: 500." },
        maxRoutes: { type: "integer", minimum: 1, description: "Max routes in the report. Default: 300." },
      },
      required: ["url"],
    },
    sideEffects: ["network", "browser"],
    async handler(args) {
      const url = requireArg(args, "url", "web");
      const opts: AnalyzeWebOptions = {
        browser: bool(args, "browser") || Boolean(str(args, "connect")),
        connectUrl: str(args, "connect") || undefined,
        browserPath: str(args, "browserPath") || undefined,
        headed: bool(args, "headed"),
        settleMs: num(args, "settleMs", 1200),
        watchSeconds: num(args, "watchSeconds", 0),
        challengeWaitMs: num(args, "challengeWaitMs", 0),
        allowChallenge: bool(args, "allowChallenge"),
        maxScripts: num(args, "maxScripts", 40),
        timeoutMs: num(args, "timeoutMs", 15000),
        userAgent: str(args, "userAgent") || undefined,
        cookie: str(args, "cookie") || undefined,
        ignoreRobots: bool(args, "ignoreRobots"),
        minLength: num(args, "minLength", 4),
        limit: num(args, "limit", 50),
        maxEndpoints: num(args, "maxEndpoints", 500),
        maxRoutes: num(args, "maxRoutes", 300),
      };
      return analyzeWeb(url, opts);
    },
  },

  {
    name: "audit",
    description:
      "Run a security & attack-surface audit against a local JS file, an .asar archive, or " +
      "a live site URL. Detects dangerous Electron settings, exposed secrets, suspicious " +
      "endpoints, DOM sinks and network calls. Returns a re-tool/audit@1 report ordered by " +
      "severity.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "A local file path, an .asar path, or an http(s) URL." },
        minSeverity: {
          type: "string",
          enum: ["critical", "high", "medium", "low", "info"],
          description: "Minimum severity to include. Default: info (all).",
        },
        web: {
          type: "object",
          description: "Options passed through when target is a live URL (same as the web tool).",
        },
      },
      required: ["target"],
    },
    sideEffects: ["readonly", "network", "browser"],
    async handler(args) {
      const target = requireArg(args, "target", "audit");
      const webArgs = (args.web ?? {}) as Record<string, unknown>;
      const sev = str(args, "minSeverity") as AuditSeverity;
      const webOptions: AnalyzeWebOptions = {
        browser: bool(webArgs, "browser") || Boolean(str(webArgs, "connect")),
        connectUrl: str(webArgs, "connect") || undefined,
        browserPath: str(webArgs, "browserPath") || undefined,
        headed: bool(webArgs, "headed"),
        settleMs: num(webArgs, "settleMs", 1200),
        watchSeconds: num(webArgs, "watchSeconds", 0),
        challengeWaitMs: num(webArgs, "challengeWaitMs", 0),
        allowChallenge: bool(webArgs, "allowChallenge"),
        maxScripts: num(webArgs, "maxScripts", 40),
        timeoutMs: num(webArgs, "timeoutMs", 15000),
        userAgent: str(webArgs, "userAgent") || undefined,
        cookie: str(webArgs, "cookie") || undefined,
        ignoreRobots: bool(webArgs, "ignoreRobots"),
      };
      return auditTarget(target, {
        minSeverity: sev || "info",
        webOptions,
      });
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** All tools in the canonical schema-agnostic form. */
export { tools };

/** Looks up a tool by name. */
export function getTool(name: string): RetoolTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new ToolError(`Unknown tool: "${name}".`, 2);
  return tool;
}

/**
 * Calls a tool by name. Convenience for harnesses that map their own schema to
 * a plain `{ name, args }` call.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return getTool(name).handler(args);
}

export type ToolFormat = "openai" | "anthropic" | "custom";

/**
 * Maps the canonical tools to a harness-specific schema.
 *
 * - "openai":   [{ type: "function", function: { name, description, parameters } }]
 * - "anthropic": [{ name, description, input_schema }]
 * - "custom":    uses `mapper` (if provided) — receive each canonical RetoolTool
 *                and return your own shape; without a mapper it returns the
 *                canonical array unchanged.
 */
export function adaptTools(
  format: ToolFormat,
  mapper?: (tool: RetoolTool) => unknown,
): unknown[] {
  if (format === "openai") {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }
  if (format === "anthropic") {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }
  return mapper ? tools.map(mapper) : [...tools];
}
