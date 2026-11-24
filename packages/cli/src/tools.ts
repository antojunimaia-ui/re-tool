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
  windowAt,
  readLine,
  scanSource,
  analyzeAsarApp,
  beautify,
  decodeInput,
  decodeAs,
  getEncodingLabel,
  analyzeWeb,
  auditTarget,
  patchAsar,
  packAsar,
  unpackSourceMap,
  probeBrowser,
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
    name: "pos",
    description:
      "Show a content window around a character offset in a file. Returns the slice of " +
      "text around `offset`. Use to inspect exactly what sits at a known offset (e.g. from " +
      "a scan or search result).",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file." },
        offset: { type: "integer", minimum: 0, description: "Character offset (0-based) to center on." },
        before: { type: "integer", minimum: 0, description: "Characters before the offset included in the window. Default: 100." },
        context: { type: "integer", minimum: 0, description: "Characters after the offset included in the window. Default: 400." },
      },
      required: ["file", "offset"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "pos");
      const offset = num(args, "offset", 0);
      const source = await readSource(file);
      return windowAt(source, offset, {
        before: num(args, "before", 100),
        context: num(args, "context", 400),
      });
    },
  },

  {
    name: "line",
    description:
      "Show one specific line of a file (1-based line number), with optional truncation. " +
      "Returns the line content and whether it was truncated. Use to read a single source " +
      "line referenced by another finding.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file." },
        line: { type: "integer", minimum: 1, description: "1-based line number." },
        maxLength: { type: "integer", minimum: 1, description: "Truncate lines longer than this. Default: 400." },
      },
      required: ["file", "line"],
    },
    sideEffects: ["readonly"],
    async handler(args) {
      const file = requireArg(args, "file", "line");
      const lineNumber = num(args, "line", 1);
      const source = await readSource(file);
      return readLine(source, lineNumber, num(args, "maxLength", 400));
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
    name: "patch",
    description:
      "Modify an Electron .asar archive: replace entries with local files, search/replace " +
      "text inside entries, append/prepend content, or remove entries. By default patches " +
      "in place (with a .bak backup); pass `out` to write a new archive. Returns a summary " +
      "of modified/added/removed entries. MUTATING: writes files.",
    inputSchema: {
      type: "object",
      properties: {
        asar: { type: "string", description: "Path to the .asar archive to patch." },
        out: { type: "string", description: "Output .asar path. Omit to patch in place (with backup)." },
        backup: { type: "boolean", description: "Create <asarPath>.bak when patching in place. Default: true." },
        replaceFiles: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Map of entry path inside the ASAR (e.g. \"app/main.js\") → local file path to replace it with.",
        },
        replaceText: {
          type: "array",
          items: {
            type: "object",
            properties: {
              file: { type: "string" },
              search: { type: "string", description: "Literal text or regex to find (string form)." },
              replace: { type: "string" },
            },
            required: ["file", "search", "replace"],
          },
          description: "Search-and-replace rules applied to text entries.",
        },
        append: {
          type: "array",
          items: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } }, required: ["file", "content"] },
          description: "Append text to entries.",
        },
        prepend: {
          type: "array",
          items: { type: "object", properties: { file: { type: "string" }, content: { type: "string" } }, required: ["file", "content"] },
          description: "Prepend text to entries.",
        },
        removeFiles: { type: "array", items: { type: "string" }, description: "Entry paths to remove from the archive." },
        unpack: { type: "string", description: "Glob for files to keep in <dest>.unpacked/ when repacking." },
      },
      required: ["asar"],
    },
    sideEffects: ["readonly", "mutating"],
    async handler(args) {
      const asar = requireArg(args, "asar", "patch");
      const replaceText = (args.replaceText as unknown[] | undefined)?.map((r) => {
        const rule = r as Record<string, unknown>;
        return {
          file: str(rule, "file"),
          search: str(rule, "search"),
          replace: str(rule, "replace"),
        };
      });
      const append = (args.append as unknown[] | undefined)?.map((r) => {
        const rule = r as Record<string, unknown>;
        return { file: str(rule, "file"), content: str(rule, "content") };
      });
      const prepend = (args.prepend as unknown[] | undefined)?.map((r) => {
        const rule = r as Record<string, unknown>;
        return { file: str(rule, "file"), content: str(rule, "content") };
      });
      return patchAsar(asar, {
        out: str(args, "out") || undefined,
        backup: bool(args, "backup", true),
        replaceFiles: (args.replaceFiles as Record<string, string> | undefined) ?? undefined,
        replaceText,
        append,
        prepend,
        removeFiles: (args.removeFiles as string[] | undefined) ?? undefined,
        unpack: str(args, "unpack") || undefined,
      });
    },
  },

  {
    name: "unpack",
    description:
      "Reconstruct the original source tree from a source map: pass a .js bundle (with " +
      "inline/external map), a .map file, or a .asar archive. Restores files into `out` " +
      "directory or returns their contents (with `contents: true`). Returns a summary of " +
      "restored files, bytes and skipped entries. MUTATING: writes files when `out` is set.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "Path to the .js bundle, .map file, or .asar archive." },
        out: { type: "string", description: "Output directory. Required unless `contents` is true." },
        match: { type: "string", description: "Glob filter on source paths (e.g. \"*.tsx\", \"src/**\")." },
        paths: { type: "array", items: { type: "string" }, description: "Exact relative paths or basenames to extract." },
        excludeNodeModules: { type: "boolean", description: "Exclude paths containing node_modules. Default: false." },
      },
      required: ["target"],
    },
    sideEffects: ["readonly", "mutating"],
    async handler(args) {
      const target = requireArg(args, "target", "unpack");
      const out = str(args, "out");
      if (!out) throw new ToolError('unpack: missing required argument "out".');
      return unpackSourceMap(target, out, {
        match: str(args, "match") || undefined,
        paths: (args.paths as string[] | undefined) ?? undefined,
        excludeNodeModules: bool(args, "excludeNodeModules"),
      });
    },
  },

  {
    name: "doctor",
    description:
      "Check the environment re-tool depends on: Node version (global WebSocket availability), " +
      "a Chromium-based browser (found? version?), that CDP actually works (launches a probe " +
      "page), outbound network, and the active defaults (max scripts, byte budgets, timeout). " +
      "Returns a re-tool/doctor@1 report. Run before debugging browser-dependent tools.",
    inputSchema: {
      type: "object",
      properties: {
        browserPath: { type: "string", description: "Explicit browser executable path to check." },
      },
    },
    sideEffects: ["readonly", "network", "browser"],
    async handler(args) {
      const started = Date.now();
      const nodeVersion = process.versions.node;
      const browser = await probeBrowser({ browserPath: str(args, "browserPath") || undefined });
      const warnings: string[] = [];
      if (!browser.path) {
        warnings.push(
          "No Chromium-based browser found: --browser is unavailable. Install Chrome/Edge/Chromium, set RETOOL_BROWSER, or pass --browser-path <path>.",
        );
      } else if (!browser.cdpOk) {
        warnings.push(`Browser found but the CDP probe failed: ${browser.error ?? "unknown error"}.`);
      }
      if (Number(nodeVersion.split(".")[0]) < 22) {
        warnings.push(`Node ${nodeVersion} has no global WebSocket: --browser needs Node >= 22.`);
      }
      return {
        schema: "re-tool/doctor@1",
        node: { version: nodeVersion, platform: process.platform, arch: process.arch },
        browser: {
          found: browser.path !== null,
          path: browser.path,
          version: browser.version,
          cdpOk: browser.cdpOk,
          ms: browser.ms,
          ...(browser.error ? { error: browser.error } : {}),
        },
        warnings,
        elapsedMs: Date.now() - started,
      };
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
