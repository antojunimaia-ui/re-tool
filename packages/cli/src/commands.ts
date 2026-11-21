import { writeFile, readFile, mkdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
  packAsar,
  patchAsar,
  unpackSourceMap,
  auditTarget,
  type AuditReport,
  type AuditSeverity,
  analyzeWeb,
  probeBrowser,
  maskSecret,
  WEB_DEFAULTS,
  type AnalyzeWebOptions,
  type WebReport,
} from "re-tool-core";
import { renderInteractive, renderPreview, renderOpenTui } from "re-tool-tui";
import {
  type ParsedArgs,
  optValue,
  optValues,
  hasFlag,
  parseNonNegativeInt,
  DEFAULT_FILE,
  resolveTarget,
  highlight,
  printJson,
  formatBytes,
} from "./args.js";

export async function cmdSearch(args: ParsedArgs): Promise<void> {
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

export async function cmdPos(args: ParsedArgs): Promise<void> {
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

export async function cmdLine(args: ParsedArgs): Promise<void> {
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

export async function cmdExtract(args: ParsedArgs): Promise<void> {
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

export async function cmdScan(args: ParsedArgs): Promise<void> {
  const file = args.positional[1];
  if (!file) {
    throw new ToolError('Usage: re-tool scan <file> [options]  (see "re-tool help")');
  }

  const minLength = parseNonNegativeInt(optValue(args.options, "min-length"), 4, "Minimum length");
  const rawLimit = optValue(args.options, "limit");
  let limit = rawLimit === undefined ? 750 : parseNonNegativeInt(rawLimit, 750, "Limit");
  const all = hasFlag(args.bools, args.options, "all", "a", "no-limit");
  if (all || limit === 0) limit = Number.MAX_SAFE_INTEGER;

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

export async function cmdAsar(args: ParsedArgs): Promise<void> {
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

function webAnalysisOptions(
  args: ParsedArgs,
  minLength: number,
  limit: number,
): AnalyzeWebOptions {
  const downloadDir = optValue(args.options, "download", "d");
  const matchPattern = optValue(args.options, "match", "m");
  const specificPaths = args.positional.slice(2);

  return {
    minLength,
    limit,
    maxScripts: parseNonNegativeInt(
      optValue(args.options, "max-scripts"),
      WEB_DEFAULTS.maxScripts,
      "Max scripts",
    ),
    timeoutMs: Math.max(
      1,
      parseNonNegativeInt(optValue(args.options, "timeout"), WEB_DEFAULTS.timeoutMs, "Timeout"),
    ),
    userAgent: optValue(args.options, "user-agent", "ua"),
    cookie: optValue(args.options, "cookie"),
    ignoreRobots: hasFlag(args.bools, args.options, "ignore-robots"),
    browser: hasFlag(args.bools, args.options, "browser"),
    browserPath: optValue(args.options, "browser-path"),
    settleMs: parseNonNegativeInt(
      optValue(args.options, "settle"),
      WEB_DEFAULTS.settleMs,
      "Settle time",
    ),
    headed: hasFlag(args.bools, args.options, "headed"),
    challengeWaitMs: parseNonNegativeInt(
      optValue(args.options, "challenge-wait"),
      hasFlag(args.bools, args.options, "headed") ? 15000 : 0,
      "Challenge wait",
    ),
    allowChallenge: hasFlag(args.bools, args.options, "allow-challenge"),
    download: downloadDir ? resolveTarget(downloadDir) : undefined,
    downloadPaths: specificPaths.length > 0 ? specificPaths : undefined,
    downloadMatch: matchPattern,
  };
}

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

export async function cmdTui(args: ParsedArgs): Promise<void> {
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
    report = await analyzeWeb(webTarget, webAnalysisOptions(args, minLength, webLimit));
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

function printWebSummary(r: WebReport): void {
  console.log(
    `[re-tool] web ${r.target} — ${r.page.status} ${r.page.contentType ?? "?"} (${formatBytes(r.page.bytes)}) in ${r.summary.elapsedMs} ms`,
  );
  if (r.page.title) console.log(`  title: ${r.page.title}`);
  if (r.page.capture === "browser") {
    console.log(
      `  capture: ${
        r.page.headed
          ? "browser window (JavaScript executed, network captured)"
          : "headless browser (JavaScript executed, network captured)"
      }`,
    );
  }
  if (r.page.challenge) {
    console.log(
      `  challenge: ${r.page.challenge.kind} (${r.page.challenge.marker}) — this is an interstitial, not the site`,
    );
  }
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

  const cov = r.coverage;
  if (cov) {
    console.log(
      `  coverage: ${cov.status} — ${cov.analyzedScripts}/${cov.discoveredScripts} scripts analyzed` +
        (cov.scriptsSkipped ? `, ${cov.scriptsSkipped} skipped` : "") +
        (cov.requestsFailed ? `, ${cov.requestsFailed} failed` : "") +
        (cov.bytesTruncated ? ", bodies truncated" : ""),
    );
    for (const gap of cov.gaps.slice(0, 6)) {
      console.log(`    - ${gap.message}`);
    }
    if (cov.gaps.length > 6) console.log(`    - (+${cov.gaps.length - 6} more in --json)`);
  }

  console.log(
    `  findings: ${r.summary.totalStrings} strings · ${r.summary.endpoints} endpoints · ${r.summary.routes} routes · ${r.summary.keys} keys · ${r.summary.featureFlags} flags`,
  );

  if (r.storage) {
    const s = r.storage;
    console.log(
      `  storage: ${s.cookies.length} cookies · ${s.localStorage.length} localStorage · ${s.sessionStorage.length} sessionStorage`,
    );
    for (const item of [...s.localStorage, ...s.sessionStorage].slice(0, 5)) {
      console.log(
        `    ${item.name} = ${
          item.value.length <= 12 ? "•".repeat(Math.min(12, Math.max(4, item.value.length))) : maskSecret(item.value)
        }`,
      );
    }
    if (s.localStorage.length + s.sessionStorage.length > 5) {
      console.log("    (full values in --json)");
    }
  }

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

export async function cmdWeb(args: ParsedArgs): Promise<void> {
  const target = args.positional[1];
  if (!target) {
    throw new ToolError('Usage: re-tool web <url> [options]  (see "re-tool help")');
  }

  const minLength = parseNonNegativeInt(optValue(args.options, "min-length"), 4, "Minimum length");
  const limit = parseNonNegativeInt(optValue(args.options, "limit"), 50, "Limit");

  const asJson = hasFlag(args.bools, args.options, "json");
  const withTui = hasFlag(args.bools, args.options, "tui");
  const preview = hasFlag(args.bools, args.options, "preview");
  const engine = optValue(args.options, "engine", "e") ?? "ansi";
  if (engine !== "ansi" && engine !== "opentui") {
    throw new ToolError(`Unknown engine: "${engine}" (use ansi | opentui)`);
  }

  const report = await analyzeWeb(target, webAnalysisOptions(args, minLength, limit));

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

  if (report.download) {
    const d = report.download;
    const downloadDir = optValue(args.options, "download", "d") ?? "out";
    console.log(
      `[re-tool] Downloaded ${d.downloaded} file(s) (${formatBytes(d.bytes)}) from ${report.target} to ${downloadDir}`,
    );
    for (const p of d.entries) console.log(`  ${p}`);
    if (d.skippedUnsafe > 0) {
      console.log(`  (skipped ${d.skippedUnsafe} unsafe path(s))`);
    }
    return;
  }

  printWebSummary(report);
}

interface NetworkProbe {
  checked: boolean;
  ok: boolean;
  host: string;
  ms: number;
  error?: string;
}

async function probeNetwork(): Promise<NetworkProbe> {
  const host = "registry.npmjs.org";
  const started = Date.now();
  try {
    const res = await fetch(`https://${host}/-/ping`, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "re-tool-doctor" },
    });
    await res.arrayBuffer();
    return { checked: true, ok: res.ok, host, ms: Date.now() - started };
  } catch (err) {
    return {
      checked: true,
      ok: false,
      host,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(path.join(here, "..", "package.json"), "utf8");
    return String((JSON.parse(raw) as { version?: string }).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const asJson = hasFlag(args.bools, args.options, "json");
  const started = Date.now();

  const nodeVersion = process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  const browser = await probeBrowser({ browserPath: optValue(args.options, "browser-path") });
  const network = await probeNetwork();

  const warnings: string[] = [];
  if (!browser.path) {
    warnings.push(
      "No Chromium-based browser found: --browser is unavailable. Install Chrome/Edge/Chromium, set RETOOL_BROWSER, or pass --browser-path <path>.",
    );
  } else if (!browser.cdpOk) {
    warnings.push(`Browser found but the CDP probe failed: ${browser.error ?? "unknown error"}.`);
  }
  if (nodeMajor < 22) {
    warnings.push(
      `Node ${nodeVersion} has no global WebSocket: --browser needs Node >= 22.`,
    );
  }
  if (!network.ok) {
    warnings.push(
      `Network check failed (${network.error ?? "unreachable"}): web analysis needs outbound HTTPS.`,
    );
  }

  const report = {
    schema: "re-tool/doctor@1",
    version: packageVersion(),
    node: { version: nodeVersion, platform: process.platform, arch: process.arch },
    browser: {
      found: browser.path !== null,
      path: browser.path,
      version: browser.version,
      cdpOk: browser.cdpOk,
      ms: browser.ms,
      ...(browser.error ? { error: browser.error } : {}),
    },
    network,
    env: {
      retoolBrowser: process.env.RETOOL_BROWSER ?? null,
    },
    defaults: {
      maxScripts: WEB_DEFAULTS.maxScripts,
      maxBytesPerAsset: WEB_DEFAULTS.maxBytesPerAsset,
      maxTotalBytes: WEB_DEFAULTS.maxTotalBytes,
      timeoutMs: WEB_DEFAULTS.timeoutMs,
      settleMs: WEB_DEFAULTS.settleMs,
    },
    warnings,
    elapsedMs: Date.now() - started,
  };

  if (asJson) {
    printJson(report);
    return;
  }

  const miles = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
  console.log(`[re-tool] doctor — ${report.version}`);
  console.log(`  node: ${nodeVersion} (${process.platform} ${process.arch})`);
  console.log(
    `  browser: ${browser.path ? (browser.version ?? browser.path) : "not found"}`,
  );
  if (browser.path) {
    console.log(`    path: ${browser.path}`);
    console.log(
      `    cdp: ${browser.cdpOk ? "ok" : "failed"} (${browser.ms} ms)${browser.error ? ` — ${browser.error}` : ""}`,
    );
  }
  console.log(
    `  network: ${network.ok ? "ok" : "failed"} (${network.host}, ${network.ms} ms)${network.error ? ` — ${network.error}` : ""}`,
  );
  console.log(
    `  defaults: max-scripts ${report.defaults.maxScripts} · ${miles(report.defaults.maxBytesPerAsset)}/asset · ${miles(report.defaults.maxTotalBytes)} total · timeout ${report.defaults.timeoutMs} ms · settle ${report.defaults.settleMs} ms`,
  );
  if (warnings.length) {
    console.log("  warnings:");
    for (const w of warnings) console.log(`    - ${w}`);
  } else {
    console.log("  warnings: none");
  }
  console.log(`  (${Date.now() - started} ms)`);
}

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
  return true;
}

export async function cmdBeautify(args: ParsedArgs): Promise<void> {
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

export async function cmdUnpack(args: ParsedArgs): Promise<void> {
  const target = args.positional[1];
  if (!target) {
    throw new ToolError(
      'Usage: re-tool unpack <file.js|file.map|app.asar> [options] [files...]\nRun "re-tool help" for details.',
    );
  }

  const resolvedTarget = resolveTarget(target);
  const outOption = optValue(args.options, "out", "o");
  const outDir = outOption
    ? resolveTarget(outOption)
    : path.resolve(process.cwd(), "unpacked");

  const matchPattern = optValue(args.options, "match", "m");
  const specificPaths = args.positional.slice(2);
  const excludeNodeModules = hasFlag(args.bools, args.options, "no-node-modules");

  const summary = await unpackSourceMap(resolvedTarget, outDir, {
    match: matchPattern,
    paths: specificPaths.length > 0 ? specificPaths : undefined,
    excludeNodeModules,
  });

  if (hasFlag(args.bools, args.options, "json")) {
    printJson(summary);
    return;
  }

  console.log(
    `[re-tool] Restored ${summary.filesRestored} original file(s) (${formatBytes(summary.bytes)}) from ${target} to ${outDir}`,
  );
  if (summary.sourceMapsFound > 0) {
    console.log(`  Source maps discovered: ${summary.sourceMapsFound}`);
  }
  if (summary.skippedNodeModules > 0) {
    console.log(`  Skipped node_modules files: ${summary.skippedNodeModules}`);
  }
  if (summary.skippedUnsafe > 0) {
    console.log(`  Skipped unsafe path(s): ${summary.skippedUnsafe}`);
  }

  const maxShown = 25;
  const shown = summary.entries.slice(0, maxShown);
  for (const entry of shown) {
    console.log(`  ${entry}`);
  }
  if (summary.entries.length > maxShown) {
    console.log(`  ... and ${summary.entries.length - maxShown} more file(s)`);
  }
}

export async function cmdAudit(args: ParsedArgs): Promise<void> {
  const target = args.positional[1] ?? optValue(args.options, "file", "f");
  if (!target) {
    throw new ToolError(
      'Usage: re-tool audit <file.js|app.asar|url> [options]\nRun "re-tool help" for details.',
    );
  }

  const rawSeverity = optValue(args.options, "severity");
  let minSeverity: AuditSeverity = "info";
  if (rawSeverity) {
    const s = rawSeverity.toLowerCase();
    if (s === "critical" || s === "high" || s === "medium" || s === "low" || s === "info") {
      minSeverity = s;
    } else {
      throw new ToolError(
        `Invalid --severity: "${rawSeverity}". Must be one of: critical, high, medium, low, info.`,
      );
    }
  }

  const outPath = optValue(args.options, "out", "o");
  const isWeb = /^https?:\/\//i.test(target);
  const resolvedTarget = isWeb ? target : resolveTarget(target);

  const report = await auditTarget(resolvedTarget, {
    minSeverity,
    webOptions: isWeb ? webAnalysisOptions(args, 4, 50) : undefined,
  });

  if (hasFlag(args.bools, args.options, "json")) {
    printJson(report);
    if (outPath) {
      await writeFile(resolveTarget(outPath), JSON.stringify(report, null, 2), "utf8");
      console.error(`[re-tool] Audit report saved to ${outPath}`);
    }
    return;
  }

  printAuditSummary(report);

  if (outPath) {
    await writeFile(resolveTarget(outPath), JSON.stringify(report, null, 2), "utf8");
    console.log(`[re-tool] JSON audit report saved to ${outPath}`);
  }
}

function printAuditSummary(report: AuditReport): void {
  const s = report.stats;
  console.log(
    `[re-tool] Security audit of ${report.target} (${report.targetType}) — ${s.filesAudited} file(s) checked`,
  );
  console.log(
    `Findings: ${s.totalFindings} total (${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low)\n`,
  );

  if (report.findings.length === 0) {
    console.log("  No security findings matching the criteria.");
    return;
  }

  for (const f of report.findings) {
    const sevLabel = `[${f.severity.toUpperCase()}]`;
    const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
    console.log(`${sevLabel} ${f.title}${loc}`);
    console.log(`  Description: ${f.description}`);
    if (f.matchSnippet) {
      console.log(`  Snippet:     ${f.matchSnippet}`);
    }
    console.log(`  Fix:         ${f.recommendation}\n`);
  }
}

export async function cmdPatch(args: ParsedArgs): Promise<void> {
  const target = args.positional[1];
  if (!target) {
    throw new ToolError('Usage: re-tool patch <app.asar|dir> [options]  (see "re-tool help")');
  }

  const resolved = resolveTarget(target);
  let isDirectory = false;
  try {
    const s = await stat(resolved);
    isDirectory = s.isDirectory();
  } catch {
    throw new ToolError(`Target path not found: ${target}`);
  }

  const asJson = hasFlag(args.bools, args.options, "json");
  const outPath = optValue(args.options, "out", "o");
  const unpackPattern = optValue(args.options, "unpack");
  const isExplicitPack = hasFlag(args.bools, args.options, "pack");

  if (isDirectory || isExplicitPack) {
    if (!outPath) {
      throw new ToolError("Packing a directory requires --out <app.asar>");
    }
    const result = await packAsar(resolved, resolveTarget(outPath), {
      unpack: unpackPattern,
    });

    if (asJson) {
      printJson({ command: "patch", action: "pack", ...result });
      return;
    }

    console.log(`[re-tool] Packed ${result.totalFiles} file(s) into ${outPath} (${formatBytes(result.totalBytes)})`);
    if (result.unpackedFiles > 0) {
      console.log(`  Unpacked: ${result.unpackedFiles} file(s) moved to ${result.unpackedDir}`);
    }
    return;
  }

  // Target is an ASAR file
  const isNoBackup = hasFlag(args.bools, args.options, "no-backup");
  const backup = !isNoBackup;

  // Replacements: --replace entry=localFile
  const rawReplacements = optValues(args.multiOptions, "replace");
  const replaceFiles: Record<string, string> = {};
  for (const r of rawReplacements) {
    const eq = r.indexOf("=");
    if (eq === -1) {
      throw new ToolError(`Invalid --replace format: "${r}". Expected format: "<entryPath>=<localPath>"`);
    }
    const entryPath = r.slice(0, eq).trim();
    const localPath = r.slice(eq + 1).trim();
    replaceFiles[entryPath] = resolveTarget(localPath);
  }

  // Removals: --remove entry
  const removeFiles = optValues(args.multiOptions, "remove");

  // In-file text editing: --file, --search, --replace-text, --append, --prepend
  const targetFileInAsar = optValue(args.options, "file", "f");
  const searchTerm = optValue(args.options, "search", "s");
  const replaceTextVal = optValue(args.options, "replace-text");
  const isRegex = hasFlag(args.bools, args.options, "regex", "r");
  const appendVal = optValue(args.options, "append");
  const prependVal = optValue(args.options, "prepend");

  const replaceTextRules = [];
  if (searchTerm !== undefined) {
    if (!targetFileInAsar) {
      throw new ToolError("--search requires --file <entryPath> to specify the target file inside the ASAR");
    }
    if (replaceTextVal === undefined) {
      throw new ToolError("--search requires --replace-text <text>");
    }
    replaceTextRules.push({
      file: targetFileInAsar,
      search: isRegex ? new RegExp(searchTerm, "g") : searchTerm,
      replace: replaceTextVal,
    });
  }

  const appendRules = [];
  if (appendVal !== undefined) {
    if (!targetFileInAsar) {
      throw new ToolError("--append requires --file <entryPath>");
    }
    appendRules.push({ file: targetFileInAsar, content: appendVal });
  }

  const prependRules = [];
  if (prependVal !== undefined) {
    if (!targetFileInAsar) {
      throw new ToolError("--prepend requires --file <entryPath>");
    }
    prependRules.push({ file: targetFileInAsar, content: prependVal });
  }

  const result = await patchAsar(resolved, {
    out: outPath ? resolveTarget(outPath) : undefined,
    backup,
    replaceFiles: Object.keys(replaceFiles).length > 0 ? replaceFiles : undefined,
    removeFiles: removeFiles.length > 0 ? removeFiles : undefined,
    replaceText: replaceTextRules.length > 0 ? replaceTextRules : undefined,
    append: appendRules.length > 0 ? appendRules : undefined,
    prepend: prependRules.length > 0 ? prependRules : undefined,
    unpack: unpackPattern,
  });

  if (asJson) {
    printJson({ command: "patch", action: "patch", ...result });
    return;
  }

  console.log(`[re-tool] Patched ${result.totalFiles} file(s) → ${result.outPath} (${formatBytes(result.totalBytes)})`);
  if (result.backupPath) {
    console.log(`  Backup created at: ${result.backupPath}`);
  }
  if (result.modified.length > 0) {
    console.log(`  Modified (${result.modified.length}): ${result.modified.join(", ")}`);
  }
  if (result.added.length > 0) {
    console.log(`  Added (${result.added.length}): ${result.added.join(", ")}`);
  }
  if (result.removed.length > 0) {
    console.log(`  Removed (${result.removed.length}): ${result.removed.join(", ")}`);
  }
  if (result.unpackedFiles > 0) {
    console.log(`  Unpacked files: ${result.unpackedFiles}`);
  }
}
