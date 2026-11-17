#!/usr/bin/env node
import { writeFile, readFile } from "node:fs/promises";
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
} from "@re-tool/core";
import { renderInteractive, renderPreview, renderOpenTui } from "@re-tool/tui";

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
    throw new ToolError(`${label} deve ser um inteiro >= 0 (recebido: "${raw}").`);
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

async function cmdTui(args: ParsedArgs): Promise<void> {
  const file = args.positional[1];
  const scanTarget = optValue(args.options, "scan", "s");
  if (!file && !scanTarget) {
    throw new ToolError(
      'Usage: re-tool tui <report.json> | re-tool tui --scan <file>  (see "re-tool help")',
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

  if (scanTarget) {
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

  if (preview) {
    if (engine === "opentui") {
      throw new ToolError("--preview is only available with --engine ansi.");
    }
    process.stdout.write(renderPreview(report as Record<string, unknown>));
    return;
  }

  if (engine === "opentui") {
    try {
      await renderOpenTui(report as Record<string, unknown>);
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

  await renderInteractive(report as Record<string, unknown>);
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
  asar <file>       List the contents of an .asar file (Electron)
  tui              Navigate a report interactively (JSON file or --scan)
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

beautify options:
  -o, --out <path>    Write output to file instead of printing

tui options:
      --scan <file>    Run analysis and open the TUI directly
      --preview        Print a static frame (no interaction; ansi engine only)
      --engine <name>  Engine: ansi (default) | opentui (needs Node >= 26.4 or Bun)
      --min-length <n> (with --scan) Ignore shorter strings

Examples:
  re-tool search "token" --file app/bundle.js
  re-tool search "getuserstatus" -i --file main.js
  re-tool search "API_[A-Z_]+" --regex --limit 20 --json
  re-tool extract "\.lsClient\.([a-zA-Z0-9_]+)\(" --file main.js --unique --json
  re-tool scan app/bundle.js --min-length 6
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
      console.error(`[re-tool] Erro: ${err.message}`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("[re-tool] Erro inesperado:", err);
  process.exit(1);
});
