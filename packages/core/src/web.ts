// Web target analysis orchestrator.
// Fetches HTML pages (HTTP or CDP browser), discovers scripts and bundles,
// executes the scan pipeline and aggregates coverage, frameworks, endpoints and findings.

import { ToolError } from "./errors.js";
import {
  captureWithBrowser,
  type BrowserCapture,
  type ChallengeInfo,
  type StorageItem,
} from "./browser.js";
import { scanSource, type ScanReport } from "./report.js";
import type { ExtractedString } from "./strings.js";
import type { FormatInfo } from "./format.js";
import type { ObfuscatorFinding } from "./obfuscators.js";
import type { SourceMapInfo } from "./sourcemap.js";
import type { FileSource } from "./index.js";

import {
  checkRobots,
  type RobotsResult,
} from "./web-robots.js";
import {
  parseHtml,
  resolveAssetUrl,
  pathOf,
  type WebAssetType,
} from "./web-html.js";
import {
  detectFrameworks,
  type FrameworkFinding,
} from "./web-frameworks.js";
import {
  extractWebFindings,
  withNetworkEndpoints,
  type FindingString,
  type WebEndpoint,
  type WebRoute,
  type WebKeyFinding,
  type WebFeatureFlag,
} from "./web-findings.js";

// Re-export submodules so external imports and types remain 100% backward compatible
export * from "./web-robots.js";
export * from "./web-html.js";
export * from "./web-frameworks.js";
export * from "./web-findings.js";

export const DEFAULT_USER_AGENT =
  "re-tool/0.4.0 (+https://github.com/antojunimaia-ui/re-tool)";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const MAX_FINDING_STRINGS = 20000;

/** Defaults shared by `analyzeWeb`, the CLI and `re-tool doctor`. */
export const WEB_DEFAULTS = {
  maxScripts: 40,
  maxBytesPerAsset: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  timeoutMs: 15000,
  settleMs: 1200,
} as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeWebOptions {
  /** Strings shorter than this are ignored. Default: 4. */
  minLength?: number;
  /** Max strings kept per script in the report. Default: 50. */
  limit?: number;
  /** Max scripts downloaded and analyzed. Default: 40 (0 = no limit). */
  maxScripts?: number;
  /** Max bytes downloaded per asset. Default: 8 MB. */
  maxBytesPerAsset?: number;
  /** Max bytes downloaded across all scripts. Default: 32 MB. */
  maxTotalBytes?: number;
  /** Per-request timeout in milliseconds. Default: 15000. */
  timeoutMs?: number;
  /** Overrides the User-Agent header. */
  userAgent?: string;
  /** Cookie header sent with every request (e.g. "session=abc; theme=dark"). */
  cookie?: string;
  /** Skips the robots.txt check (use only on targets you own). */
  ignoreRobots?: boolean;
  /** Max endpoints included in the report. Default: 500. */
  maxEndpoints?: number;
  /** Max routes included in the report. Default: 300. */
  maxRoutes?: number;
  /**
   * Captures the page with a real (headless) browser instead of plain HTTP.
   * Needed for sites behind JavaScript challenges and SPA-rendered apps.
   * Default: false.
   */
  browser?: boolean;
  /** Explicit browser executable for `browser` mode. */
  browserPath?: string;
  /** Extra wait after the load event in `browser` mode. Default: 1200. */
  settleMs?: number;
  /** Shows a real browser window instead of headless (helps with challenges). */
  headed?: boolean;
  /** Extra wait for a detected challenge to clear (default: 15 s when headed). */
  challengeWaitMs?: number;
  /** Keeps the challenge page in the report instead of failing. Default: false. */
  allowChallenge?: boolean;
}

export interface WebAsset {
  url: string;
  path: string;
  type: WebAssetType;
  fetched: boolean;
  bytes: number;
  status: number | null;
  ok: boolean;
  error?: string;
  analyzed: boolean;
  /** The body was cut short by a size cap, so findings are incomplete. */
  truncated?: boolean;
  /** Where the body came from: browser capture or a direct HTTP fetch. */
  via?: "http" | "browser";
}

/** Why part of the target was not analyzed. */
export type WebGapKind =
  | "script-limit"
  | "byte-budget"
  | "truncated"
  | "fetch-error"
  | "parse-error"
  | "challenge";

export interface WebGap {
  kind: WebGapKind;
  /** Human-readable sentence, safe to print. */
  message: string;
  /** How many items this gap accounts for. */
  count: number;
  /** Affected asset URLs, capped to keep the report small. */
  assets?: string[];
}

/**
 * How complete the analysis is. `partial` means the numbers describe
 * only what was analyzed — never the whole target.
 */
export interface WebCoverage {
  status: "complete" | "partial";
  /** Scripts declared by the page (external + inline). */
  discoveredScripts: number;
  analyzedScripts: number;
  /** Scripts dropped by `--max-scripts` or the byte budget. */
  scriptsSkipped: number;
  scriptsSkippedByLimit: number;
  scriptsSkippedByBudget: number;
  /** Scripts that could not be downloaded or parsed. */
  requestsFailed: number;
  /** Any body (page or asset) was cut by a size cap. */
  bytesTruncated: boolean;
  gaps: WebGap[];
}

export interface WebFileAnalysis {
  path: string;
  url: string;
  size: number;
  format: FormatInfo;
  parseError?: string;
  webpackModules: number;
  obfuscators: ObfuscatorFinding[];
  sourceMap: SourceMapInfo;
  strings: ScanReport["strings"];
  stringTotal: number;
  stringChars: number;
}

export interface WebPageInfo {
  status: number;
  contentType: string | null;
  bytes: number;
  title: string | null;
  description: string | null;
  generator: string | null;
  baseUrl: string;
  userAgent: string;
  /** true when the browser-like UA retry was needed to get the page. */
  userAgentFallback: boolean;
  /** How the page HTML was obtained. */
  capture: "http" | "browser";
  /** In `browser` mode: whether a visible window was used. */
  headed?: boolean;
  /** Set when the page is a bot challenge/interstitial rather than the site. */
  challenge?: ChallengeInfo;
  redirects: { from: string; to: string }[];
  robots: { checked: boolean; allowed: boolean; rule?: string };
}

export interface WebStorage {
  cookies: StorageItem[];
  localStorage: StorageItem[];
  sessionStorage: StorageItem[];
}

export interface WebSummary {
  elapsedMs: number;
  assets: number;
  scripts: number;
  scriptsAnalyzed: number;
  jsBytes: number;
  fetchErrors: number;
  skippedAssets: number;
  totalStrings: number;
  frameworks: number;
  endpoints: number;
  routes: number;
  keys: number;
  featureFlags: number;
}

export interface WebReport {
  schema: "re-tool/web-report@1";
  target: string;
  requested: string;
  fetchedAt: string;
  page: WebPageInfo;
  frameworks: FrameworkFinding[];
  assets: WebAsset[];
  files: WebFileAnalysis[];
  endpoints: WebEndpoint[];
  routes: WebRoute[];
  keys: WebKeyFinding[];
  featureFlags: WebFeatureFlag[];
  /** Cookies/web storage captured in `browser` mode. */
  storage?: WebStorage;
  /** Whether every discovered script was analyzed. */
  coverage: WebCoverage;
  summary: WebSummary;
}

// ---------------------------------------------------------------------------
// URL helpers & HTTP
// ---------------------------------------------------------------------------

/** Normalizes a user-provided URL (adds https:// when the scheme is missing). */
export function normalizeUrl(input: string): URL {
  const raw = input.trim();
  if (raw === "") throw new ToolError("URL cannot be empty.");

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ToolError(`Invalid URL: "${input}"`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(
      `Unsupported protocol "${url.protocol}" (only http and https are supported).`,
    );
  }
  url.hash = "";
  return url;
}

export interface FetchedResource {
  url: string;
  status: number;
  contentType: string | null;
  bytes: number;
  text: string;
  truncated: boolean;
}

interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  cookie?: string;
  accept?: string;
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return "request timed out";
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${cause.code}${cause.message ? ` (${cause.message})` : ""}`;
    if (cause?.message) return cause.message;
    return err.message;
  }
  return String(err);
}

/** Fetches a resource, capping the number of bytes buffered. */
export async function fetchResource(
  url: string,
  opts: FetchOptions = {},
): Promise<FetchedResource> {
  const timeoutMs = opts.timeoutMs ?? WEB_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;

  let res: Response;
  const headers: Record<string, string> = {
    "user-agent": opts.userAgent ?? DEFAULT_USER_AGENT,
    accept: opts.accept ?? "*/*",
    "accept-language": "en-US,en;q=0.9",
  };
  if (opts.cookie) headers.cookie = opts.cookie;

  try {
    res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
  } catch (err) {
    throw new ToolError(`Request failed for ${url}: ${describeFetchError(err)}`);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  const reader = res.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - total;
      if (value.byteLength > room) {
        if (room > 0) chunks.push(value.subarray(0, room));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return {
    url: res.url || url,
    status: res.status,
    contentType: res.headers.get("content-type"),
    bytes: buffer.byteLength,
    text: buffer.toString("utf8"),
    truncated,
  };
}

function httpStatusHint(status: number): string {
  switch (status) {
    case 401:
      return ". The page requires authentication — pass a session with --cookie \"name=value\" if you have one.";
    case 403:
      return ". The site rejected the request (bot protection or a required session). Try --user-agent \"<browser UA>\" or --cookie \"name=value\"; sites protected by JS challenges need a real browser.";
    case 406:
      return ". The site refused the requested representation — try a different --user-agent.";
    case 429:
      return ". Rate limited — wait and retry, or raise --timeout.";
    case 451:
      return ". Unavailable for legal reasons.";
    default:
      return "";
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Per-script analysis
// ---------------------------------------------------------------------------

interface ScriptAnalysisFile extends WebFileAnalysis {
  findings: ExtractedString[];
}

function toPublicFile(file: ScriptAnalysisFile): WebFileAnalysis {
  const { findings: _findings, ...rest } = file;
  return rest;
}

async function analyzeScript(
  content: string,
  url: string,
  displayPath: string,
  opts: { minLength: number; limit: number },
): Promise<ScriptAnalysisFile> {
  const source: FileSource = {
    path: displayPath,
    content,
    lines: content.split("\n"),
  };

  const scan = await scanSource(source, {
    minLength: opts.minLength,
    limit: MAX_FINDING_STRINGS,
  });

  return {
    path: source.path,
    url,
    size: Buffer.byteLength(content, "utf8"),
    format: scan.format,
    ...(scan.parseError ? { parseError: scan.parseError } : {}),
    webpackModules: scan.summary.webpackModules,
    obfuscators: scan.obfuscators,
    sourceMap: scan.sourceMap,
    strings: scan.strings.slice(0, opts.limit),
    stringTotal: scan.summary.totalStrings,
    stringChars: scan.summary.totalStringChars,
    findings: scan.strings,
  };
}

// ---------------------------------------------------------------------------
// Main analysis entry point
// ---------------------------------------------------------------------------

export async function analyzeWeb(
  input: string,
  opts: AnalyzeWebOptions = {},
): Promise<WebReport> {
  const started = Date.now();
  const requested = normalizeUrl(input);

  const minLength = opts.minLength ?? 4;
  const limit = Math.max(1, opts.limit ?? 50);
  const maxScripts = opts.maxScripts ?? WEB_DEFAULTS.maxScripts;
  const maxBytesPerAsset = opts.maxBytesPerAsset ?? WEB_DEFAULTS.maxBytesPerAsset;
  const totalLimit = opts.maxTotalBytes ?? WEB_DEFAULTS.maxTotalBytes;
  let byteBudget = totalLimit;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const userAgent = opts.userAgent;
  const cookie = opts.cookie;

  const robots = opts.ignoreRobots
    ? { checked: false, allowed: true }
    : await checkRobots(requested, fetchResource, { timeoutMs, userAgent, cookie });

  if (!robots.allowed) {
    throw new ToolError(
      `Blocked by robots.txt for ${requested.pathname}${robots.rule ? ` (${robots.rule})` : ""}. ` +
        "Use --ignore-robots only on targets you own or are authorized to test.",
    );
  }

  const useBrowser = opts.browser === true;
  let captured: BrowserCapture | null = null;

  let usedUserAgent = userAgent ?? DEFAULT_USER_AGENT;
  let userAgentFallback = false;
  let page: FetchedResource;

  if (useBrowser) {
    try {
      captured = await captureWithBrowser(requested.href, {
        browserPath: opts.browserPath,
        timeoutMs: Math.max(timeoutMs, 20000),
        settleMs: opts.settleMs,
        maxTotalBytes: totalLimit,
        cookie,
        userAgent,
        headed: opts.headed === true,
        challengeWaitMs: opts.challengeWaitMs,
      });
    } catch (err) {
      throw err instanceof ToolError ? err : new ToolError(String(err));
    }

    if (captured.challenge && opts.allowChallenge !== true) {
      throw new ToolError(
        `The page is still a bot challenge (${captured.challenge.kind}: ${captured.challenge.marker}), not the site itself.\n` +
          "Options:\n" +
          '  - reuse the clearance cookie from your own browser: --cookie "cf_clearance=..."\n' +
          "  - let the challenge run in a visible window: --headed --settle 3000\n" +
          "  - keep the challenge page in the report anyway: --allow-challenge",
      );
    }

    page = {
      url: captured.url,
      status: captured.status,
      contentType: captured.contentType,
      bytes: Buffer.byteLength(captured.html, "utf8"),
      text: captured.html,
      truncated: false,
    };
    usedUserAgent = captured.userAgent || BROWSER_USER_AGENT;
  } else {
    const fetchPage = (ua: string) =>
      fetchResource(requested.href, {
        timeoutMs,
        maxBytes: 4 * 1024 * 1024,
        userAgent: ua,
        cookie,
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      });

    try {
      page = await fetchPage(usedUserAgent);
    } catch (err) {
      throw err instanceof ToolError ? err : new ToolError(String(err));
    }

    if (!userAgent && (page.status === 403 || page.status === 406 || page.status === 429)) {
      try {
        const retry = await fetchPage(BROWSER_USER_AGENT);
        if (retry.status < 400) {
          page = retry;
          usedUserAgent = BROWSER_USER_AGENT;
          userAgentFallback = true;
        }
      } catch {
        /* keep the original response/hint */
      }
    }
  }

  if (page.status >= 400) {
    throw new ToolError(
      `HTTP ${page.status} for ${page.url}${httpStatusHint(page.status)}${
        useBrowser ? "" : " Use --browser to execute JavaScript challenges in a real (headless) browser."
      }`,
    );
  }

  const parsed = parseHtml(page.text, page.url);

  // ---- Asset discovery ----
  const discovered: { url: string; type: WebAssetType }[] = [];
  const seen = new Set<string>();
  const addAsset = (raw: string, type: WebAssetType) => {
    const url = resolveAssetUrl(raw, parsed.baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    discovered.push({ url, type });
  };

  for (const script of parsed.scripts) {
    if (script.src) addAsset(script.src, "script");
  }
  for (const link of parsed.links) {
    if (link.rel.includes("modulepreload")) addAsset(link.href, "modulepreload");
    else if (link.rel.includes("preload") && link.as === "script") {
      addAsset(link.href, "preload");
    }
  }

  const stylesheets: WebAsset[] = [];
  for (const link of parsed.links) {
    if (link.rel.includes("stylesheet")) {
      const url = resolveAssetUrl(link.href, parsed.baseUrl);
      if (!url) continue;
      stylesheets.push({
        url,
        path: pathOf(url),
        type: "stylesheet",
        fetched: false,
        bytes: 0,
        status: null,
        ok: false,
        analyzed: false,
      });
    }
  }

  const scriptAssets = maxScripts > 0 ? discovered.slice(0, maxScripts) : discovered;
  const skippedByLimit = discovered.length - scriptAssets.length;

  const inlineScripts = parsed.scripts
    .filter((s) => !s.src && s.inline && s.inline.trim() !== "")
    .map((s, i) => ({ path: `inline[${i + 1}]`, content: s.inline as string }));

  // ---- Fetch + analyze ----
  const files: WebFileAnalysis[] = [];
  const findingStrings: FindingString[] = [];
  const assets: WebAsset[] = [];
  const scriptTexts: string[] = [];

  const capturedScripts = new Map<string, { text: string; status: number; bytes: number }>();
  if (captured) {
    for (const res of captured.responses) {
      if (res.body === undefined || res.resourceType !== "Script") continue;
      capturedScripts.set(res.url, {
        text: res.body,
        status: res.status,
        bytes: Buffer.byteLength(res.body, "utf8"),
      });
    }
  }

  const fetched = await mapLimit(scriptAssets, 4, async (asset) => {
    if (byteBudget <= 0) {
      return {
        asset,
        error: "skipped (total byte budget reached)",
        skipped: true,
        text: null as string | null,
        bytes: 0,
        status: null as number | null,
        truncated: false,
        via: "http" as const,
      };
    }

    const fromBrowser = capturedScripts.get(asset.url);
    if (fromBrowser) {
      byteBudget -= fromBrowser.bytes;
      return {
        asset,
        error: undefined,
        skipped: false,
        text: fromBrowser.text,
        bytes: fromBrowser.bytes,
        status: fromBrowser.status,
        truncated: false,
        via: "browser" as const,
      };
    }

    try {
      const res = await fetchResource(asset.url, {
        timeoutMs,
        maxBytes: Math.min(maxBytesPerAsset, byteBudget),
        userAgent,
        accept: "text/javascript,application/javascript,*/*;q=0.8",
      });
      byteBudget -= res.bytes;

      if (res.status >= 400) {
        return {
          asset,
          error: `HTTP ${res.status}`,
          skipped: false,
          text: null as string | null,
          bytes: res.bytes,
          status: res.status,
          truncated: res.truncated,
          via: "http" as const,
        };
      }
      return {
        asset,
        error: undefined,
        skipped: false,
        text: res.text,
        bytes: res.bytes,
        status: res.status,
        truncated: res.truncated,
        via: "http" as const,
      };
    } catch (err) {
      return {
        asset,
        error: err instanceof Error ? err.message : String(err),
        skipped: false,
        text: null as string | null,
        bytes: 0,
        status: null as number | null,
        truncated: false,
        via: "http" as const,
      };
    }
  });

  let fetchErrors = 0;
  let skippedAssets = 0;
  let jsBytes = 0;
  let scriptsAnalyzed = 0;
  let truncatedAssets = 0;
  const skippedByBudgetUrls: string[] = [];
  const fetchErrorUrls: string[] = [];
  const truncatedUrls: string[] = [];
  const parseErrorUrls: string[] = [];

  for (const item of fetched) {
    const { asset } = item;
    const ok = item.error === undefined && item.text !== null;

    assets.push({
      url: asset.url,
      path: pathOf(asset.url),
      type: asset.type,
      fetched: true,
      bytes: item.bytes,
      status: item.status,
      ok,
      analyzed: false,
      via: item.via,
      ...(item.truncated ? { truncated: true } : {}),
      ...(item.error ? { error: item.error } : {}),
    });

    if (item.truncated) {
      truncatedAssets++;
      truncatedUrls.push(asset.url);
    }

    if (!ok || item.text === null) {
      if (item.skipped) {
        skippedAssets++;
        skippedByBudgetUrls.push(asset.url);
      } else {
        fetchErrors++;
        fetchErrorUrls.push(asset.url);
      }
      continue;
    }

    if (jsBytes + item.bytes > totalLimit) {
      skippedAssets++;
      skippedByBudgetUrls.push(asset.url);
      assets[assets.length - 1].error = "skipped (total byte budget reached)";
      continue;
    }

    jsBytes += item.bytes;
    scriptTexts.push(item.text.slice(0, 1_000_000));
    assets[assets.length - 1].analyzed = true;
    scriptsAnalyzed++;

    const file = await analyzeScript(item.text, asset.url, pathOf(asset.url), {
      minLength,
      limit,
    });
    if (file.parseError) parseErrorUrls.push(file.path);
    files.push(toPublicFile(file));
    findingStrings.push({ path: file.path, strings: file.findings });
  }

  for (const inline of inlineScripts) {
    const url = `${page.url}#${inline.path}`;
    const file = await analyzeScript(inline.content, url, inline.path, { minLength, limit });
    if (file.parseError) parseErrorUrls.push(file.path);
    files.push(toPublicFile(file));
    findingStrings.push({ path: file.path, strings: file.findings });
    scriptsAnalyzed++;
    assets.push({
      url,
      path: inline.path,
      type: "inline",
      fetched: false,
      bytes: Buffer.byteLength(inline.content, "utf8"),
      status: null,
      ok: true,
      analyzed: true,
    });
    scriptTexts.push(inline.content);
  }

  assets.push(...stylesheets);

  // ---- Findings ----
  const findings = extractWebFindings(findingStrings, {
    maxEndpoints: opts.maxEndpoints,
    maxRoutes: opts.maxRoutes,
  });

  if (captured) {
    findings.endpoints = withNetworkEndpoints(
      findings.endpoints,
      captured.responses,
      page.url,
      opts.maxEndpoints ?? 500,
    );
  }

  const frameworks = detectFrameworks({
    html: page.text,
    scripts: scriptTexts,
    urls: discovered.map((d) => d.url),
  });

  const totalStrings = files.reduce((acc, f) => acc + f.stringTotal, 0);

  // ---- Coverage ----
  const discoveredScripts = discovered.length + inlineScripts.length;
  const scriptsSkipped = skippedByLimit + skippedAssets;
  const bytesTruncated = truncatedAssets > 0 || page.truncated === true;
  const sample = (urls: string[]) => urls.slice(0, 20);
  const gaps: WebGap[] = [];

  if (skippedByLimit > 0) {
    gaps.push({
      kind: "script-limit",
      count: skippedByLimit,
      message:
        `${skippedByLimit} script(s) were not analyzed because of --max-scripts ${maxScripts}. ` +
        "Raise the limit (0 = no limit) to include them.",
      assets: sample(discovered.slice(maxScripts).map((d) => d.url)),
    });
  }
  if (skippedByBudgetUrls.length > 0) {
    gaps.push({
      kind: "byte-budget",
      count: skippedByBudgetUrls.length,
      message:
        `${skippedByBudgetUrls.length} script(s) were skipped after the ` +
        `${Math.round(totalLimit / (1024 * 1024))} MB total byte budget.`,
      assets: sample(skippedByBudgetUrls),
    });
  }
  if (truncatedAssets > 0) {
    gaps.push({
      kind: "truncated",
      count: truncatedAssets,
      message:
        `${truncatedAssets} script body(ies) were cut at the per-asset size cap ` +
        `(${Math.round(maxBytesPerAsset / (1024 * 1024))} MB); findings from them are incomplete.`,
      assets: sample(truncatedUrls),
    });
  }
  if (page.truncated) {
    gaps.push({
      kind: "truncated",
      count: 1,
      message: "The page HTML was cut at the 4 MB cap; only the first part was parsed.",
      assets: [page.url],
    });
  }
  if (fetchErrorUrls.length > 0) {
    gaps.push({
      kind: "fetch-error",
      count: fetchErrorUrls.length,
      message: `${fetchErrorUrls.length} script(s) could not be downloaded.`,
      assets: sample(fetchErrorUrls),
    });
  }
  if (parseErrorUrls.length > 0) {
    gaps.push({
      kind: "parse-error",
      count: parseErrorUrls.length,
      message:
        `${parseErrorUrls.length} script(s) could not be parsed as JavaScript; ` +
        "string extraction fell back to heuristics and may be incomplete.",
      assets: sample(parseErrorUrls),
    });
  }
  if (captured?.challenge) {
    gaps.push({
      kind: "challenge",
      count: 1,
      message:
        `The page is a ${captured.challenge.kind} bot challenge, not the site; ` +
        "findings describe the interstitial.",
    });
  }

  const coverage: WebCoverage = {
    status: gaps.length === 0 ? "complete" : "partial",
    discoveredScripts,
    analyzedScripts: scriptsAnalyzed,
    scriptsSkipped,
    scriptsSkippedByLimit: skippedByLimit,
    scriptsSkippedByBudget: skippedAssets,
    requestsFailed: fetchErrors,
    bytesTruncated,
    gaps,
  };

  const report: WebReport = {
    schema: "re-tool/web-report@1",
    target: page.url,
    requested: requested.href,
    fetchedAt: new Date().toISOString(),
    page: {
      status: page.status,
      contentType: page.contentType,
      bytes: page.bytes,
      title: parsed.title,
      description: parsed.meta["description"] ?? parsed.meta["og:description"] ?? null,
      generator: parsed.meta["generator"] ?? null,
      baseUrl: parsed.baseUrl,
      userAgent: usedUserAgent,
      userAgentFallback,
      capture: useBrowser ? "browser" : "http",
      ...(useBrowser ? { headed: opts.headed === true } : {}),
      ...(captured?.challenge ? { challenge: captured.challenge } : {}),
      redirects:
        page.url === requested.href ? [] : [{ from: requested.href, to: page.url }],
      robots,
    },
    coverage,
    frameworks,
    assets,
    files,
    endpoints: findings.endpoints,
    routes: findings.routes,
    keys: findings.keys,
    featureFlags: findings.featureFlags,
    ...(captured ? { storage: captured.storage } : {}),
    summary: {
      elapsedMs: Date.now() - started,
      assets: assets.length,
      scripts: discovered.length + inlineScripts.length,
      scriptsAnalyzed,
      jsBytes,
      fetchErrors,
      skippedAssets,
      totalStrings,
      frameworks: frameworks.length,
      endpoints: findings.endpoints.length,
      routes: findings.routes.length,
      keys: findings.keys.length,
      featureFlags: findings.featureFlags.length,
    },
  };

  return report;
}
