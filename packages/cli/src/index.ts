#!/usr/bin/env node
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ToolError,
  readSource,
  findMatches,
  windowAt,
  readLine,
  scanSource,
  beautify,
  loadAsar,
  analyzeAsarApp,
  extractCaptures,
  extractAsarFiles,
  analyzeWeb,
  maskSecret,
  type WebReport,
} from "re-tool-core";
import { renderInteractive, renderPreview, renderOpenTui } from "re-tool-tui";

// Argument parser (lightweight, no external deps)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  bools: Set<string>;
}

/** Flags that never consume the next token (purely boolean). */
const BOOL_FLAGS = new Set([
  "json",
  "regex",
  "r",
  "preview",
  "ignore-case",
  "i",
  "unique",
  "u",
  "all",
  "a",
  "no-limit",
  "extract",
  "ignore-robots",
  "tui",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const bools = new Set<string>();

  const isBool = (key: string): boolean => BOOL_FLAGS.has(key);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq !== -1 ? a.slice(2, eq) : a.slice(2);
      if (eq !== -1) {
        if (isBool(key)) bools.add(key);
        else options.set(key, a.slice(eq + 1));
      } else if (isBool(key)) {
        bools.add(key);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options.set(key, next);
          i++;
        } else {
          bools.add(key);
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const key = a.slice(1);
      if (isBool(key)) {
        bools.add(key);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          options.set(key, next);
          i++;
        } else {
          bools.add(key);
        }
      }
    } else {
      positional.push(a);
    }
  }

  return { positional, options, bools };
}

function optValue(options: Map<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = options.get(n);
    if (v !== undefined) return v;
  }
  return undefined;
}

function hasFlag(bools: Set<string>, options: Map<string, string>, ...names: string[]): boolean {
  for (const n of names) {
    if (bools.has(n) || options.has(n)) return true;
  }
  return false;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    throw new ToolError(`${label} must be an integer >= 0 (got: "${raw}").`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const DEFAULT_FILE = "main.js";

/** Normalizes a target path (Windows backslashes, relative paths, etc.). */
function resolveTarget(p: string): string {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const colorized = process.stdout.isTTY;

/** Highlights the found term (only when output is a terminal). */
function highlight(text: string): string {
  return colorized ? `${BOLD}${RED}${text}${RESET}` : text;
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const term = args.positional[1] ?? "";
  if (term === "") {
    throw new ToolError('Usage: re-tool search <term> [options]  (see "re-tool help")');
  }

  const file = resolveTarget(optValue(args.options, "file", "f") ?? DEFAULT_FILE);
  const context = parseNonNegativeInt(optValue(args.options, "context", "c"), 400, "Context");
  const rawLimit = optValue(args.options, "limit", "l");
  let limit = rawLimit === undefined ? 5 : parseNonNegativeInt(rawLimit, 5, "Limit");
  const all = hasFlag(args.bools, args.options, "all", "a", "no-limit");
  if (all || limit === 0) limit = Number.MAX_SAFE_INTEGER;
  const regex = hasFlag(args.bools, args.options, "regex", "r");
  const ignoreCase = hasFlag(args.bools, args.options, "ignore-case", "i");
  const asJson = hasFlag(args.bools, args.options, "json");

  const source = await readSource(file);
  const result = findMatches(source, term, { context, limit, regex, ignoreCase });

  if (asJson) {
    printJson({ command: "search", ...result });
    return;
  }

  const needle = regex ? `/${term}/` : `"${term}"`;
  console.log(
    `[re-tool] Searching ${needle} in ${file}` +
      (result.totalMatches > 0 ? ` — ${result.totalMatches} occurrence(s)` : ""),
  );

  for (let i = 0; i < result.matches.length; i++) {
    const m = result.matches[i];
    console.log();
    console.log(`--- [Match #${i + 1}] line ${m.line}, column ${m.column} (index ${m.index}) ---`);
    console.log(m.contextBefore + highlight(m.match) + m.contextAfter);
  }

  if (result.truncated) {
    console.log(`\n... more occurrences omitted (total: ${result.totalMatches})`);
  }
  if (result.totalMatches === 0) {
    console.log("No occurrences found.");
  }
}

async function cmdPos(args: ParsedArgs): Promise<void> {
  const rawOffset = args.positional[1];
  if (rawOffset === undefined) {
    throw new ToolError('Usage: re-tool pos <offset> [options]  (see "re-tool help")');
  }

  const offset = parseNonNegativeInt(rawOffset, 0, "Offset");
  const file = resolveTarget(optValue(args.options, "file", "f") ?? DEFAULT_FILE);
  const context = parseNonNegativeInt(optValue(args.options, "context", "c"), 400, "Context");
  const before = parseNonNegativeInt(optValue(args.options, "before", "b"), 100, "Before");
  const asJson = hasFlag(args.bools, args.options, "json");

  const source = await readSource(file);
  const result = windowAt(source, offset, { context, before });

  if (asJson) {
    printJson({ command: "pos", ...result });
    return;
  }

  console.log(`[re-tool] Window around offset ${offset} (indices ${result.start}..${result.end}) in ${file}:`);
  console.log(result.slice);
}

async function cmdLine(args: ParsedArgs): Promise<void> {
  const rawLine = args.positional[1];
  if (rawLine === undefined) {
    throw new ToolError('Usage: re-tool line <number> [options]  (see "re-tool help")');
  }

  const lineNumber = parseNonNegativeInt(rawLine, 0, "Line");
  const file = resolveTarget(optValue(args.options, "file", "f") ?? DEFAULT_FILE);
  const size = parseNonNegativeInt(optValue(args.options, "size", "s"), 400, "Size");
  const asJson = hasFlag(args.bools, args.options, "json");

  const source = await readSource(file);
  const result = readLine(source, lineNumber, size);

  if (asJson) {
    printJson({ command: "line", ...result });
    return;
  }

  console.log(`[re-tool] Line ${lineNumber} of ${file}:`);
  console.log(result.content);
  if (result.truncated) {
    console.log(`\n... content truncated to ${size} characters`);
  }
}

async function cmdExtract(args: ParsedArgs): Promise<void> {
  const pattern = args.positional[1];
  if (!pattern) {
    throw new ToolError('Usage: re-tool extract <regex> [options]  (see "re-tool help")');
  }

  const file = resolveTarget(optValue(args.options, "file", "f") ?? DEFAULT_FILE);
  const unique = hasFlag(args.bools, args.options, "unique", "u");
  const asJson = hasFlag(args.bools, args.options, "json");
  const rawLimit = optValue(args.options, "limit");
  let limit = rawLimit === undefined ? 1000 : parseNonNegativeInt(rawLimit, 1000, "Limit");
  const all = hasFlag(args.bools, args.options, "all", "a", "no-limit");
  if (all || limit === 0) limit = Number.MAX_SAFE_INTEGER;

  const source = await readSource(file);
  const result = extractCaptures(source, pattern, { unique, limit });

  if (asJson) {
    console.log(JSON.stringify(result.captures));
    return;
  }
  for (const cap of result.captures) console.log(cap);
  if (result.truncated) {
    console.error(
      `[re-tool] note: extraction truncated at ${result.captures.length} captures (${result.total} occurrences)`,
    );
  }
}

async function cmdScan(args: ParsedArgs): Promise<void> {
  const file = args.positional[1];
  if (!file) {
    throw new ToolError('Usage: re-tool scan <file> [options]  (see "re-tool help")');
  }

  const minLength = parseNonNegativeInt(optValue(args.options, "min-length"), 4, "Minimum length");
  const rawLimit = optValue(args.options, "limit");
  let limit = rawLimit === undefined ? 750 : parseNonNegativeInt(rawLimit, 750, "Limit");
  const all = hasFlag(args.bools, args.options, "all", "a", "no-limit");
  if (all || limit === 0) limit = Number.MAX_SAFE_INTEGER;

  // scan accepts .asar (Electron apps) and delegates to aggregated analysis.
  const targetFile = resolveTarget(file);
  if (/\.asar$/i.test(targetFile)) {
    const report = await analyzeAsarApp(targetFile, { minLength, limit });
    printJson(report);
    return;
  }

  const source = await readSource(targetFile);
  const report = await scanSource(source, { minLength, limit });
  printJson(report);
}

async function cmdAsar(args: ParsedArgs): Promise<void> {
  const file = args.positional[1];
  if (!file) {
    throw new ToolError('Usage: re-tool asar <file.asar> [options]  (see "re-tool help")');
  }

  const asJson = hasFlag(args.bools, args.options, "json");
  const target = resolveTarget(file);

  const extract = hasFlag(args.bools, args.options, "extract");
  const outDir = optValue(args.options, "out", "o");
  const matchPattern = optValue(args.options, "match", "m");
  const specificPaths = args.positional.slice(2);

  if (extract) {
    if (!outDir) {
      throw new ToolError('--extract requires --out <dir>');
    }
    const summary = await extractAsarFiles(target, outDir, {
      paths: specificPaths.length > 0 ? specificPaths : undefined,
      match: matchPattern,
    });

    if (asJson) {
      printJson({ command: "asar", action: "extract", target, outDir, ...summary });
      return;
    }

    console.log(
      `[re-tool] Extracted ${summary.extracted} file(s) (${summary.bytes} bytes) to ${outDir}`,
    );
    for (const p of summary.entries) console.log(`  ${p}`);
    if (summary.skippedUnpacked > 0) {
      console.log(`  (skipped ${summary.skippedUnpacked} unpacked entries)`);
    }
    if (summary.skippedUnsafe > 0) {
      console.log(`  (skipped ${summary.skippedUnsafe} unsafe path(s))`);
    }
    return;
  }

  const { archive } = await loadAsar(target);

  if (asJson) {
    printJson({
      command: "asar",
      target: file,
      totalFiles: archive.entries.length,
      totalBytes: archive.totalBytes,
      entries: archive.entries.map((e) => ({
        path: e.path,
        size: e.size,
        offset: e.offset,
        unpacked: e.unpacked,
      })),
    });
    return;
  }

  console.log(
    `[re-tool] ${file} — ${archive.entries.length} file(s), ${archive.totalBytes} bytes`,
  );
  for (const e of archive.entries) {
    console.log(
      `  ${e.path}  ${e.size}B  offset=${e.offset}${e.unpacked ? "  [unpacked]" : ""}`,
    );
  }
}

/** Renders a report with the selected TUI engine. */
async function openReport(
  report: Record<string, unknown>,
  engine: string,
  preview: boolean,
): Promise<void> {
  if (preview) {
    if (engine === "opentui") {
      throw new ToolError("--preview is only available with --engine ansi.");
    }
    process.stdout.write(renderPreview(report));
    return;
  }

  if (engine === "opentui") {
    try {
      await renderOpenTui(report);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("OpenTUI requires")) {
        if (relaunchWithPortableNode()) return;
        throw new ToolError(
          `${err.message}\n(note: portable Node in .tools/ was not found — install Node >= 26.4 or Bun)`,
        );
      }
      throw err;
    }
    return;
  }

  await renderInteractive(report);
}

async function cmdTui(args: ParsedArgs): Promise<void> {
  const file = args.positional[1];
  const scanTarget = optValue(args.options, "scan", "s");
  const webTarget = optValue(args.options, "web", "w");
  if (!file && !scanTarget && !webTarget) {
    throw new ToolError(
      'Usage: re-tool tui <report.json> | re-tool tui --scan <file> | re-tool tui --web <url>  (see "re-tool help")',
    );
  }

  const minLength = parseNonNegativeInt(optValue(args.options, "min-length"), 4, "Minimum length");
  const limit = parseNonNegativeInt(optValue(args.options, "limit"), 750, "Limit");
  const preview = hasFlag(args.bools, args.options, "preview");
  const engine = optValue(args.options, "engine", "e") ?? "ansi";
  if (engine !== "ansi" && engine !== "opentui") {
    throw new ToolError(`Unknown engine: "${engine}" (use ansi | opentui)`);
  }

  let report: unknown;

  if (webTarget) {
    const webLimit = args.options.has("limit") ? limit : 50;
    report = await analyzeWeb(webTarget, {
      minLength,
      limit: webLimit,
      maxScripts: parseNonNegativeInt(optValue(args.options, "max-scripts"), 40, "Max scripts"),
      timeoutMs: Math.max(
        1,
        parseNonNegativeInt(optValue(args.options, "timeout"), 15000, "Timeout"),
      ),
      userAgent: optValue(args.options, "user-agent", "ua"),
      cookie: optValue(args.options, "cookie"),
      ignoreRobots: hasFlag(args.bools, args.options, "ignore-robots"),
    });
  } else if (scanTarget) {
    const targetFile = resolveTarget(scanTarget);
    report = /\.asar$/i.test(targetFile)
      ? await analyzeAsarApp(targetFile, { minLength, limit })
      : await scanSource(await readSource(targetFile), { minLength, limit });
  } else {
    let raw: string;
    try {
      raw = await readFile(resolveTarget(file), "utf8");
    } catch {
      throw new ToolError(`File not found: ${file}`);
    }
    try {
      report = JSON.parse(raw.replace(/^\uFEFF/, "")) as Record<string, unknown>;
    } catch (err) {
      throw new ToolError(
        `Invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await openReport(report as Record<string, unknown>, engine, preview);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Compact human-readable summary of a web report (JSON stays the source of truth). */
function printWebSummary(r: WebReport): void {
  console.log(
    `[re-tool] web ${r.target} — ${r.page.status} ${r.page.contentType ?? "?"} (${formatBytes(r.page.bytes)}) in ${r.summary.elapsedMs} ms`,
  );
  if (r.page.title) console.log(`  title: ${r.page.title}`);
  if (r.page.userAgentFallback) {
    console.log("  ua: retried with a browser-like User-Agent (site rejected re-tool UA)");
  }
  console.log(
    `  robots: ${
      r.page.robots.checked
        ? r.page.robots.allowed
          ? "allowed"
          : "blocked"
        : "not checked"
    }${r.page.robots.rule ? ` (${r.page.robots.rule})` : ""}`,
  );

  if (r.frameworks.length) {
    console.log(
      `  frameworks: ${r.frameworks
        .map((f) => `${f.name}${f.version ? ` ${f.version}` : ""} [${f.category}]`)
        .join(", ")}`,
    );
  }

  console.log(
    `  assets: ${r.summary.assets} · scripts ${r.summary.scripts} (analyzed ${r.summary.scriptsAnalyzed}${
      r.summary.fetchErrors ? `, ${r.summary.fetchErrors} failed` : ""
    }${r.summary.skippedAssets ? `, ${r.summary.skippedAssets} skipped` : ""}) · JS ${formatBytes(r.summary.jsBytes)}`,
  );
  console.log(
    `  findings: ${r.summary.totalStrings} strings · ${r.summary.endpoints} endpoints · ${r.summary.routes} routes · ${r.summary.keys} keys · ${r.summary.featureFlags} flags`,
  );

  if (r.keys.length) {
    console.log("  keys:");
    for (const k of r.keys.slice(0, 10)) {
      console.log(`    ${k.kind}  ${maskSecret(k.value)}  (${k.source}:${k.line})`);
    }
    if (r.keys.length > 10) {
      console.log(`    (+${r.keys.length - 10} more — use --json)`);
    }
  }

  if (r.endpoints.length) {
    console.log("  endpoints (top 10 by occurrences):");
    for (const e of r.endpoints.slice(0, 10)) {
      console.log(`    ${e.value}  (${e.kind} x${e.count})  ${e.source}:${e.line}`);
    }
  }

  if (r.routes.length) {
    console.log("  routes (top 10 by occurrences):");
    for (const x of r.routes.slice(0, 10)) {
      console.log(`    ${x.path}  x${x.count}  ${x.source}:${x.line}`);
    }
  }

  console.log(`  (full report: re-tool web ${r.target} --json)`);
}

async function cmdWeb(args: ParsedArgs): Promise<void> {
  const target = args.positional[1];
  if (!target) {
    throw new ToolError('Usage: re-tool web <url> [options]  (see "re-tool help")');
  }

  const minLength = parseNonNegativeInt(optValue(args.options, "min-length"), 4, "Minimum length");
  const limit = parseNonNegativeInt(optValue(args.options, "limit"), 50, "Limit");
  const maxScripts = parseNonNegativeInt(optValue(args.options, "max-scripts"), 40, "Max scripts");
  const timeoutMs = Math.max(
    1,
    parseNonNegativeInt(optValue(args.options, "timeout"), 15000, "Timeout"),
  );

  const asJson = hasFlag(args.bools, args.options, "json");
  const withTui = hasFlag(args.bools, args.options, "tui");
  const preview = hasFlag(args.bools, args.options, "preview");
  const engine = optValue(args.options, "engine", "e") ?? "ansi";
  if (engine !== "ansi" && engine !== "opentui") {
    throw new ToolError(`Unknown engine: "${engine}" (use ansi | opentui)`);
  }

  const report = await analyzeWeb(target, {
    minLength,
    limit,
    maxScripts,
    timeoutMs,
    userAgent: optValue(args.options, "user-agent", "ua"),
    cookie: optValue(args.options, "cookie"),
    ignoreRobots: hasFlag(args.bools, args.options, "ignore-robots"),
  });

  const outPath = optValue(args.options, "out", "o");
  if (outPath) {
    const dest = path.resolve(outPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.error(`[re-tool] Report written to ${dest}`);
  }

  if (asJson) {
    printJson(report);
    return;
  }

  if (withTui || preview) {
    await openReport(report as unknown as Record<string, unknown>, engine, preview);
    return;
  }

  printWebSummary(report);
}

/**
 * Re-launches the same command under the project's portable Node 26 (if it
 * exists) when the current runtime does not meet OpenTUI's requirement.
 */
function relaunchWithPortableNode(): boolean {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const nodeBin = path.join(
    root,
    ".tools/node-v26.13.1-win-x64/node.exe",
  );
  if (!existsSync(nodeBin)) return false;

  const args = ["--experimental-ffi", process.argv[1] ?? "", ...process.argv.slice(2)];
  const result = spawnSync(nodeBin, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
  return true; // unreachable
}

async function cmdBeautify(args: ParsedArgs): Promise<void> {
  const file = args.positional[1];
  if (!file) {
    throw new ToolError('Usage: re-tool beautify <file> [options]  (see "re-tool help")');
  }

  const outPath = optValue(args.options, "out", "o");
  const asJson = hasFlag(args.bools, args.options, "json");

  const source = await readSource(resolveTarget(file));
  const result = await beautify(source.content);

  if (asJson) {
    printJson({
      command: "beautify",
      file,
      ok: result.ok,
      error: result.error,
      inputBytes: source.content.length,
      outputBytes: result.code.length,
      code: result.code,
    });
    return;
  }

  if (outPath) {
    await writeFile(outPath, result.code, "utf8");
    console.log(
      `[re-tool] Formatted code saved to ${outPath} (${source.content.length} → ${result.code.length} bytes)`,
    );
    if (!result.ok) {
      console.error(
        `[re-tool] Warning: default parser failed; content copied unformatted.` +
          (result.error ? ` (${result.error})` : ""),
      );
    }
    return;
  }

  process.stdout.write(result.code.endsWith("\n") ? result.code : result.code + "\n");
  if (!result.ok) {
    console.error(
      `[re-tool] Warning: default parser failed; content returned unformatted.` +
        (result.error ? ` (${result.error})` : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// Ajuda e ponto de entrada
// ---------------------------------------------------------------------------

const HELP = `
re-tool — reverse engineering assistant (JS/Electron)

Usage:
  re-tool <command> [args] [options]

Commands:
  search <term>     Search for occurrences and show surrounding context
  extract <regex>   Extract regex capture groups (group 1 or full match)
  scan <file>       Run the analysis pipeline (format, strings, summary) → JSON
                    (accepts .asar: analyzes the whole Electron app)
  web <url>         Analyze a live site (HTML + JS bundles)
                    finds frameworks, endpoints, routes, keys, flags
  asar <file>       List the contents of an .asar file (Electron)
  tui              Navigate a report interactively (JSON file or --scan/--web)
  beautify <file>   Reformat (de-minify) code for reading
  pos <offset>      Show a content window around an offset
  line <number>     Show a specific line of the file
  help             Show this help

Common options:
  -f, --file <path>   Target file (default: main.js)
      --json           Structured JSON output
  -c, --context <n>   Context size (default: 400)

search options:
  -l, --limit <n>     Max occurrences shown (default: 5; 0 = unlimited)
  -r, --regex         Treat <term> as a regular expression
  -i, --ignore-case   Case-insensitive search
  -a, --all, --no-limit  Show all occurrences

extract options:
  -u, --unique         Remove duplicate captures
      --json           Output a JSON array of captures
      --limit <n>      Max captures (default: 1000; 0 = unlimited)
  -a, --all, --no-limit  Extract all captures

pos options:
  -b, --before <n>    Characters before the offset (default: 100)

asar options:
      --extract        Extract entries to --out
      --match <glob>   With --extract: only matching entries (e.g. "*.js")
  -o, --out <dir>     With --extract: output directory
                      (specific files can be passed as trailing args)

scan options:
      --min-length <n> Ignore strings shorter than this (default: 4)
      --limit <n>      Max strings in the report (default: 750)

web options:
      --json           Print the full report as JSON
  -o, --out <path>     Also write the JSON report to a file
      --min-length <n> Ignore strings shorter than this (default: 4)
      --limit <n>      Max strings per script in the report (default: 50)
      --max-scripts <n> Max scripts downloaded (default: 40)
      --timeout <ms>   Per-request timeout (default: 15000)
      --user-agent <ua> Override the User-Agent header
      --cookie <header> Cookie header sent with every request (session=abc; theme=dark)
      --ignore-robots  Skip the robots.txt check (only on authorized targets)
      --tui            Open the TUI right after the analysis
      --preview        Print a static TUI frame
      --engine <name>  TUI engine: ansi (default) | opentui

beautify options:
  -o, --out <path>    Write output to file instead of printing

tui options:
      --scan <file>    Run analysis and open the TUI directly
      --web <url>      Analyze a live site and open the TUI directly
                       (accepts --user-agent, --cookie, --ignore-robots, --max-scripts, --timeout)
      --preview        Print a static frame (no interaction; ansi engine only)
      --engine <name>  Engine: ansi (default) | opentui (needs Node >= 26.4 or Bun)
      --min-length <n> (with --scan/--web) Ignore shorter strings

Examples:
  re-tool search "token" --file app/bundle.js
  re-tool search "getuserstatus" -i --file main.js
  re-tool search "API_[A-Z_]+" --regex --limit 20 --json
  re-tool extract "\.lsClient\.([a-zA-Z0-9_]+)\(" --file main.js --unique --json
  re-tool scan app/bundle.js --min-length 6
  re-tool web https://example.com
  re-tool web example.com --json --out web-report.json
  re-tool web https://example.com --tui
  re-tool tui --web https://example.com
  re-tool beautify app/bundle.js --out bundle.pretty.js
  re-tool tui report.json
  re-tool tui --scan app/bundle.js
  re-tool pos 4096 --file app/main.js --context 200
  re-tool line 42 --file app/main.js
  re-tool asar app.asar --extract --out dist/
  re-tool asar app.asar --extract --out dist/ renderer.js main.js
  re-tool asar app.asar --extract --out dist/ --match "*.js"
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { positional, options, bools } = parseArgs(argv);

  const command = positional[0];
  if (!command || command === "help") {
    console.log(HELP);
    return;
  }

  const args: ParsedArgs = { positional, options, bools };
  try {
    switch (command) {
      case "search":
        await cmdSearch(args);
        break;
      case "pos":
        await cmdPos(args);
        break;
      case "line":
        await cmdLine(args);
        break;
      case "scan":
        await cmdScan(args);
        break;
      case "web":
        await cmdWeb(args);
        break;
      case "extract":
        await cmdExtract(args);
        break;
      case "beautify":
        await cmdBeautify(args);
        break;
      case "asar":
        await cmdAsar(args);
        break;
      case "tui":
        await cmdTui(args);
        break;
      default:
        throw new ToolError(`Unknown command: "${command}". Use "re-tool help".`, 2);
    }
  } catch (err) {
    if (err instanceof ToolError) {
      console.error(`[re-tool] Error: ${err.message}`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("[re-tool] Unexpected error:", err);
  process.exit(1);
});
