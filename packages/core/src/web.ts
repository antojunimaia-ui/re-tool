// Web target analysis (no browser). Fetches an HTML page, discovers its
// scripts and bundles, runs the regular scan pipeline over each one, and
// reports frameworks, endpoints, routes, feature flags and embedded keys.
//
// This module is intentionally dependency-free: HTML is parsed with
// heuristics (attribute/script/link extraction) and everything else reuses the
// existing analysis modules.
import { ToolError } from "./errors.js";
import { scanSource, type ScanReport } from "./report.js";
import type { ExtractedString } from "./strings.js";
import type { FormatInfo } from "./format.js";
import type { ObfuscatorFinding } from "./obfuscators.js";
import type { SourceMapInfo } from "./sourcemap.js";
import type { FileSource } from "./index.js";

const DEFAULT_USER_AGENT =
  "re-tool/0.2.0 (+https://github.com/antojunimaia-ui/re-tool)";

// Used for a single retry when a site rejects the honest re-tool UA with
// 403/406/429 (common with bot protection). The report records which UA won.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_FINDING_STRINGS = 20000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeWebOptions {
  /** Strings shorter than this are ignored. Default: 4. */
  minLength?: number;
  /** Max strings kept per script in the report. Default: 50. */
  limit?: number;
  /** Max scripts downloaded and analyzed. Default: 40. */
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
}

export type WebAssetType =
  | "script"
  | "inline"
  | "modulepreload"
  | "preload"
  | "stylesheet"
  | "other";

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

export type FrameworkCategory =
  | "framework"
  | "build"
  | "cms"
  | "analytics"
  | "auth"
  | "captcha"
  | "state"
  | "hosting"
  | "other";

export interface FrameworkFinding {
  name: string;
  category: FrameworkCategory;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  version?: string;
}

export type EndpointKind = "http" | "ws" | "relative";

export interface WebEndpoint {
  value: string;
  kind: EndpointKind;
  count: number;
  source: string;
  line: number;
}

export interface WebRoute {
  path: string;
  count: number;
  source: string;
  line: number;
}

export interface WebKeyFinding {
  kind: string;
  value: string;
  source: string;
  line: number;
}

export interface WebFeatureFlag {
  name: string;
  source: string;
  line: number;
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
  redirects: { from: string; to: string }[];
  robots: { checked: boolean; allowed: boolean; rule?: string };
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
  summary: WebSummary;
}

// ---------------------------------------------------------------------------
// URL helpers
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

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname === "/" ? "/" : u.pathname;
    return u.search ? `${p}${u.search}` : p;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

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
async function fetchResource(
  url: string,
  opts: FetchOptions = {},
): Promise<FetchedResource> {
  const timeoutMs = opts.timeoutMs ?? 15000;
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

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsResult {
  checked: boolean;
  allowed: boolean;
  rule?: string;
}

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface ParsedRobots {
  groups: { agents: string[]; rules: RobotsRule[] }[];
}

/** Parses robots.txt into groups of (agents, rules). */
export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: ParsedRobots["groups"] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (key === "disallow" || key === "allow") {
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    }
  }

  return { groups };
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  if (pattern === "") return true;
  let regex = "^";
  for (const ch of pattern) {
    if (ch === "*") regex += ".*";
    else regex += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  if (!pattern.endsWith("$")) regex += ".*";
  return new RegExp(regex).test(path);
}

/**
 * Resolves whether `pathname` is allowed for `agent` given robots.txt text.
 * Longest matching pattern wins; on ties, Allow wins.
 */
export function robotsAllows(
  robots: ParsedRobots,
  pathname: string,
  agent = "re-tool",
): { allowed: boolean; rule?: string } {
  const agentToken = agent.toLowerCase();
  let best: { rule: RobotsRule; length: number } | null = null;

  for (const group of robots.groups) {
    const applies = group.agents.some(
      (a) => a === "*" || agentToken.includes(a.split("/")[0]),
    );
    if (!applies) continue;

    for (const rule of group.rules) {
      if (!robotsPatternMatches(rule.pattern, pathname)) continue;
      const length = rule.pattern.length;
      if (
        !best ||
        length > best.length ||
        (length === best.length && rule.allow && !best.rule.allow)
      ) {
        best = { rule, length };
      }
    }
  }

  if (!best) return { allowed: true };
  return {
    allowed: best.rule.allow,
    rule: `${best.rule.allow ? "Allow" : "Disallow"}: ${best.rule.pattern}`,
  };
}

async function checkRobots(
  pageUrl: URL,
  opts: FetchOptions & { agent?: string },
): Promise<RobotsResult> {
  const robotsUrl = new URL("/robots.txt", pageUrl).href;
  try {
    const res = await fetchResource(robotsUrl, {
      timeoutMs: opts.timeoutMs,
      maxBytes: 512 * 1024,
      userAgent: opts.userAgent,
      accept: "text/plain,*/*",
    });
    if (res.status !== 200) {
      return { checked: true, allowed: true };
    }
    const parsed = parseRobotsTxt(res.text);
    const { allowed, rule } = robotsAllows(parsed, pageUrl.pathname, opts.agent);
    return { checked: true, allowed, rule };
  } catch {
    // A missing/unreachable robots.txt must not block the analysis.
    return { checked: false, allowed: true };
  }
}

// ---------------------------------------------------------------------------
// HTML discovery
// ---------------------------------------------------------------------------

export interface ParsedHtml {
  title: string | null;
  baseUrl: string;
  meta: Record<string, string>;
  scripts: { src: string | null; inline: string | null; type: string | null }[];
  links: { href: string; rel: string; as: string | null }[];
}

const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Extracts lowercased attributes from a single HTML tag's source. */
export function parseHtmlAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tag)) !== null) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out[m[1].toLowerCase()] = decodeHtmlEntities(value);
  }
  return out;
}

/** Parses the parts of an HTML document that matter for asset discovery. */
export function parseHtml(html: string, pageUrl: string): ParsedHtml {
  const baseTag = /<base\b[^>]*>/i.exec(html);
  let baseUrl = pageUrl;
  if (baseTag) {
    const href = parseHtmlAttributes(baseTag[0]).href;
    if (href) {
      try {
        baseUrl = new URL(href, pageUrl).href;
      } catch {
        /* keep pageUrl */
      }
    }
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || null
    : null;

  const meta: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = parseHtmlAttributes(tag);
    const key = (attrs.name ?? attrs.property ?? attrs["http-equiv"] ?? "").toLowerCase();
    if (key && attrs.content !== undefined) meta[key] = attrs.content;
  }

  const scripts: ParsedHtml["scripts"] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = scriptRe.exec(html)) !== null) {
    const attrs = parseHtmlAttributes(sm[1]);
    const src = attrs.src ? decodeHtmlEntities(attrs.src) : null;
    scripts.push({
      src,
      inline: src ? null : sm[2],
      type: attrs.type ?? null,
    });
  }

  const links: ParsedHtml["links"] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attrs = parseHtmlAttributes(tag);
    if (!attrs.href) continue;
    links.push({
      href: attrs.href,
      rel: (attrs.rel ?? "").toLowerCase(),
      as: attrs.as ? attrs.as.toLowerCase() : null,
    });
  }

  return { title, baseUrl, meta, scripts, links };
}

function resolveAssetUrl(raw: string, baseUrl: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;
  if (/^(?:data|blob|javascript|mailto|tel|about|chrome-extension):/i.test(trimmed)) {
    return null;
  }
  try {
    const url = new URL(trimmed, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Framework signatures
// ---------------------------------------------------------------------------

interface Signature {
  name: string;
  category: FrameworkCategory;
  needles: string[];
  strong?: string[];
  version?: RegExp;
}

const SIGNATURES: Signature[] = [
  {
    name: "React",
    category: "framework",
    needles: [
      "__react_devtools_global_hook__",
      "react-dom",
      "react.production.min",
      "data-reactroot",
      "react.element",
    ],
    strong: ["__react_devtools_global_hook__", "data-reactroot"],
    version: /react-dom@?([0-9]+\.[0-9]+\.[0-9]+)/i,
  },
  { name: "Preact", category: "framework", needles: ["preact"], strong: ["preact"] },
  {
    name: "Vue",
    category: "framework",
    needles: ["__vue__", "vue.runtime", "createapp(", "data-v-"],
    strong: ["__vue__", "vue.runtime"],
  },
  { name: "Nuxt", category: "framework", needles: ["__nuxt__", "/_nuxt/"], strong: ["__nuxt__"] },
  {
    name: "Next.js",
    category: "framework",
    needles: ["__next_data__", "/_next/static", "__next_f", "next/router"],
    strong: ["__next_data__", "/_next/static"],
  },
  {
    name: "Angular",
    category: "framework",
    needles: ["ng-version", "platformbrowserdynamic", "@angular/core", "\u0275\u0275"],
    strong: ["ng-version", "platformbrowserdynamic"],
    version: /ng-version="([0-9]+\.[0-9]+\.[0-9]+[^"]*)"/i,
  },
  {
    name: "Svelte",
    category: "framework",
    needles: ["__svelte", "sveltecomponent", "svelte-"],
    strong: ["__svelte"],
  },
  {
    name: "SvelteKit",
    category: "framework",
    needles: ["__sveltekit", "/_app/immutable"],
    strong: ["__sveltekit"],
  },
  { name: "Solid", category: "framework", needles: ["solid-js", "createsignal"], strong: ["solid-js"] },
  { name: "Astro", category: "framework", needles: ["astro-island", "/_astro/"], strong: ["astro-island"] },
  { name: "Remix", category: "framework", needles: ["__remixcontext"], strong: ["__remixcontext"] },
  {
    name: "Gatsby",
    category: "framework",
    needles: ["___gatsby", "/page-data/"],
    strong: ["___gatsby"],
  },
  { name: "Ember", category: "framework", needles: ["ember.application", "ember.debug"], strong: ["ember.application"] },
  { name: "jQuery", category: "other", needles: ["jquery", "jquery.fn"], strong: ["jquery.fn"] },
  { name: "Alpine.js", category: "framework", needles: ["x-data", "alpine.start"], strong: ["alpine.start"] },
  { name: "htmx", category: "framework", needles: ["hx-get", "htmx"], strong: ["hx-get"] },
  { name: "Backbone", category: "framework", needles: ["backbone.model"], strong: ["backbone.model"] },
  { name: "Redux", category: "state", needles: ["__redux_devtools_extension__", "redux"], strong: ["__redux_devtools_extension__"] },
  { name: "Zustand", category: "state", needles: ["zustand"], strong: ["zustand"] },
  { name: "Pinia", category: "state", needles: ["pinia"], strong: ["pinia"] },
  { name: "Vite", category: "build", needles: ["/@vite/", "vite/modulepreload-polyfill", "__vite__"], strong: ["/@vite/", "__vite__"] },
  { name: "Webpack", category: "build", needles: ["webpackchunk", "__webpack_require__"], strong: ["webpackchunk"] },
  { name: "Parcel", category: "build", needles: ["parcelrequire"], strong: ["parcelrequire"] },
  { name: "Turbopack", category: "build", needles: ["turbopack"], strong: ["turbopack"] },
  { name: "WordPress", category: "cms", needles: ["wp-content", "wp-includes", "wp-json"], strong: ["wp-content", "wp-json"] },
  { name: "Shopify", category: "cms", needles: ["cdn.shopify.com", "shopify"], strong: ["cdn.shopify.com"] },
  { name: "Magento", category: "cms", needles: ["magento_", "mage/"], strong: ["magento_"] },
  { name: "Drupal", category: "cms", needles: ["drupalsettings", "/sites/default/files"], strong: ["drupalsettings"] },
  { name: "Ghost", category: "cms", needles: ["ghost-url", "ghost.org"], strong: ["ghost-url"] },
  { name: "Webflow", category: "other", needles: ["webflow"], strong: ["webflow"] },
  { name: "Wix", category: "other", needles: ["wixstatic", "parastorage"], strong: ["wixstatic"] },
  { name: "Squarespace", category: "other", needles: ["squarespace"], strong: ["squarespace"] },
  { name: "Google Analytics", category: "analytics", needles: ["googletagmanager.com/gtag", "gtag(", "google-analytics.com"], strong: ["googletagmanager.com/gtag"] },
  { name: "Google Tag Manager", category: "analytics", needles: ["googletagmanager.com/gtm", "dataLayer"], strong: ["googletagmanager.com/gtm"] },
  { name: "Segment", category: "analytics", needles: ["cdn.segment.com", "analytics.load("], strong: ["cdn.segment.com"] },
  { name: "Mixpanel", category: "analytics", needles: ["mixpanel"], strong: ["mixpanel"] },
  { name: "Amplitude", category: "analytics", needles: ["amplitude"], strong: ["amplitude"] },
  { name: "PostHog", category: "analytics", needles: ["posthog"], strong: ["posthog"] },
  { name: "Sentry", category: "analytics", needles: ["sentry.init", "sentry.io", "@sentry/"], strong: ["sentry.init"] },
  { name: "Datadog RUM", category: "analytics", needles: ["datadog-rum", "dd_rum"], strong: ["datadog-rum"] },
  { name: "Hotjar", category: "analytics", needles: ["hotjar"], strong: ["hotjar"] },
  { name: "FullStory", category: "analytics", needles: ["fullstory"], strong: ["fullstory"] },
  { name: "Stripe.js", category: "other", needles: ["js.stripe.com", "stripe("], strong: ["js.stripe.com"] },
  { name: "Firebase", category: "other", needles: ["firebaseio.com", "firebaseapp.com", "firebase."], strong: ["firebaseio.com"] },
  { name: "Supabase", category: "other", needles: ["supabase.co"], strong: ["supabase.co"] },
  { name: "Auth0", category: "auth", needles: ["auth0"], strong: ["auth0"] },
  { name: "Clerk", category: "auth", needles: ["clerk."], strong: ["clerk."] },
  { name: "LaunchDarkly", category: "other", needles: ["launchdarkly"], strong: ["launchdarkly"] },
  { name: "Unleash", category: "other", needles: ["unleash"], strong: ["unleash"] },
  { name: "GrowthBook", category: "other", needles: ["growthbook"], strong: ["growthbook"] },
  { name: "Optimizely", category: "other", needles: ["optimizely"], strong: ["optimizely"] },
  { name: "reCAPTCHA", category: "captcha", needles: ["recaptcha", "grecaptcha"], strong: ["grecaptcha"] },
  { name: "hCaptcha", category: "captcha", needles: ["hcaptcha"], strong: ["hcaptcha"] },
  { name: "Cloudflare Turnstile", category: "captcha", needles: ["challenges.cloudflare.com"], strong: ["challenges.cloudflare.com"] },
  { name: "Cloudflare", category: "hosting", needles: ["cdnjs.cloudflare.com", "__cf_bm"], strong: ["cdnjs.cloudflare.com"] },
  { name: "Intercom", category: "other", needles: ["intercom"], strong: ["intercom"] },
  { name: "Algolia", category: "other", needles: ["algolia"], strong: ["algolia"] },
];

export interface FrameworkInput {
  html: string;
  scripts: string[];
  urls?: string[];
}

/** Detects frameworks/CMS/analytics from HTML text, scripts and asset URLs. */
export function detectFrameworks(input: FrameworkInput): FrameworkFinding[] {
  const hay = [input.html, ...input.scripts, ...(input.urls ?? [])]
    .join("\n")
    .toLowerCase();

  const out: FrameworkFinding[] = [];
  for (const sig of SIGNATURES) {
    const hits = sig.needles.filter((n) => hay.includes(n.toLowerCase()));
    if (hits.length === 0) continue;

    const strongHit = (sig.strong ?? []).some((n) => hay.includes(n.toLowerCase()));
    const confidence: FrameworkFinding["confidence"] =
      strongHit || hits.length >= 2 ? "high" : "medium";

    const finding: FrameworkFinding = {
      name: sig.name,
      category: sig.category,
      confidence,
      evidence: hits.slice(0, 3),
    };

    if (sig.version) {
      const m = sig.version.exec(hay);
      if (m?.[1]) finding.version = m[1];
    }
    out.push(finding);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Findings: endpoints, routes, keys, feature flags
// ---------------------------------------------------------------------------

const NOISE_HOSTS = [
  "w3.org",
  "schema.org",
  "react.dev",
  "reactjs.org",
  "developer.mozilla.org",
  "unicode.org",
  "tc39.es",
  "ecma-international.org",
  "opensource.org",
  "creativecommons.org",
  "gnu.org",
  "json-schema.org",
  "whatwg.org",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/gi;
const API_PATH_RE =
  /^\/(?:api|v[1-9]\d*|graphql|gql|rest|rpc|trpc|auth|oauth2?|session|ws|socket|internal|admin)\b/i;

const ASSET_EXT_RE =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf|xml|txt|wasm|html?)$/i;

function trimUrlPunctuation(value: string): string {
  return value.replace(/[.,;:!?)\]}>'"]+$/g, "");
}

function isNoiseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }
  // URLs with embedded credentials (e.g. Sentry DSNs) belong to `keys`, not
  // to the endpoint list.
  if (parsed.username !== "" || parsed.password !== "") return true;

  const host = parsed.hostname.toLowerCase();
  if (NOISE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  if (/\.(?:map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf)$/i.test(value)) {
    return true;
  }
  return false;
}

function looksLikeRoute(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  if (value.length < 2 || value.length > 120) return false;
  if (/[\s{}<>"'`\\]/.test(value)) return false;
  if (ASSET_EXT_RE.test(value)) return false;
  if (API_PATH_RE.test(value)) return false;
  if (/^\/(?:_next|_nuxt|_astro|_app|static|assets|public|dist|media)\//i.test(value)) {
    return false;
  }

  const segments = value.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(
    (seg) =>
      /^[A-Za-z0-9._~-]+$/.test(seg) ||
      /^:[A-Za-z_][A-Za-z0-9_]*\??$/.test(seg) ||
      /^\[[A-Za-z0-9_.-]+\]$/.test(seg) ||
      seg === "*" ||
      seg === "**",
  );
}

const KEY_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "publishable-key", re: /pk_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: "secret-key", re: /sk_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { kind: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "google-oauth-client", re: /[0-9]{6,}-[0-9a-z]{32}\.apps\.googleusercontent\.com/g },
  { kind: "firebase", re: /https:\/\/[a-z0-9-]+\.(?:firebaseio\.com|firebaseapp\.com)/g },
  { kind: "aws-access-key", re: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { kind: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "slack-token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "sentry-dsn", re: /https:\/\/[0-9a-f]{32}@[^\s/"']+\/[0-9]+/g },
  { kind: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { kind: "openai-key", re: /sk-[A-Za-z0-9]{32,}/g },
  { kind: "mapbox-token", re: /pk\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g },
  { kind: "supabase-url", re: /https:\/\/[a-z0-9]{20}\.supabase\.co/g },
];

const FLAG_PATTERNS: RegExp[] = [
  /\b((?:FEATURE|ENABLE|ENABLED|FF|FLAG|EXPERIMENT|BETA|ROLLOUT)_[A-Z0-9_]{2,})\b/g,
  /\b((?:feature|enable|flag|experiment|beta)[A-Z][A-Za-z0-9]{2,})\b/g,
  /\b(feature_flag|feature_flags|featureFlag|featureFlags)\b/g,
];

export interface FindingString {
  path: string;
  strings: ExtractedString[];
}

export interface WebFindings {
  endpoints: WebEndpoint[];
  routes: WebRoute[];
  keys: WebKeyFinding[];
  featureFlags: WebFeatureFlag[];
}

/** Extracts endpoints, routes, keys and feature flags from extracted strings. */
export function extractWebFindings(
  files: FindingString[],
  opts: { maxEndpoints?: number; maxRoutes?: number } = {},
): WebFindings {
  const maxEndpoints = opts.maxEndpoints ?? 500;
  const maxRoutes = opts.maxRoutes ?? 300;

  const endpoints = new Map<string, WebEndpoint>();
  const routes = new Map<string, WebRoute>();
  const keys = new Map<string, WebKeyFinding>();
  const flags = new Map<string, WebFeatureFlag>();

  const addEndpoint = (value: string, kind: EndpointKind, f: FindingString, s: ExtractedString) => {
    const key = `${kind}:${value}`;
    const existing = endpoints.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    endpoints.set(key, { value, kind, count: 1, source: f.path, line: s.line });
  };

  const addRoute = (value: string, f: FindingString, s: ExtractedString) => {
    const existing = routes.get(value);
    if (existing) {
      existing.count++;
      return;
    }
    routes.set(value, { path: value, count: 1, source: f.path, line: s.line });
  };

  for (const file of files) {
    for (const s of file.strings) {
      const value = s.value;

      // --- absolute URLs (http/https/ws/wss) ---
      const urlMatches = value.match(URL_RE) ?? [];
      for (const raw of urlMatches) {
        const url = trimUrlPunctuation(raw);
        if (url.length < 8 || url.includes("${") || isNoiseUrl(url)) continue;
        const kind: EndpointKind = /^wss?:/i.test(url) ? "ws" : "http";
        addEndpoint(url, kind, file, s);
      }

      // --- relative API paths ---
      if (
        API_PATH_RE.test(value) &&
        value.length <= 300 &&
        !/\s/.test(value) &&
        !value.includes("${") &&
        !ASSET_EXT_RE.test(value)
      ) {
        addEndpoint(value, "relative", file, s);
      }

      // --- SPA routes ---
      if (looksLikeRoute(value)) addRoute(value, file, s);

      // --- embedded keys ---
      for (const { kind, re } of KEY_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(value)) !== null) {
          const found = m[0];
          const key = `${kind}:${found}`;
          if (!keys.has(key)) {
            keys.set(key, { kind, value: found, source: file.path, line: s.line });
          }
          if (m[0].length === 0) re.lastIndex++;
        }
      }

      // --- feature flags ---
      for (const re of FLAG_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(value)) !== null) {
          const name = m[1];
          if (name !== "featureFlags" && !flags.has(name)) {
            flags.set(name, { name, source: file.path, line: s.line });
          }
          if (m[0].length === 0) re.lastIndex++;
        }
      }
    }
  }

  const sortByCountThenValue = <T extends { count: number }>(a: T, b: T, value: (x: T) => string) =>
    b.count - a.count || value(a).localeCompare(value(b));

  return {
    endpoints: [...endpoints.values()]
      .sort((a, b) => sortByCountThenValue(a, b, (x) => x.value))
      .slice(0, maxEndpoints),
    routes: [...routes.values()]
      .sort((a, b) => sortByCountThenValue(a, b, (x) => x.path))
      .slice(0, maxRoutes),
    keys: [...keys.values()],
    featureFlags: [...flags.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Masks a secret for display: keeps a short prefix/suffix. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return value.slice(0, 4) + "\u2026";
  return `${value.slice(0, 6)}\u2026${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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

export async function analyzeWeb(
  input: string,
  opts: AnalyzeWebOptions = {},
): Promise<WebReport> {
  const started = Date.now();
  const requested = normalizeUrl(input);

  const minLength = opts.minLength ?? 4;
  const limit = Math.max(1, opts.limit ?? 50);
  const maxScripts = opts.maxScripts ?? 40;
  const maxBytesPerAsset = opts.maxBytesPerAsset ?? 8 * 1024 * 1024;
  const totalLimit = opts.maxTotalBytes ?? 32 * 1024 * 1024;
  let byteBudget = totalLimit;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const userAgent = opts.userAgent;
  const cookie = opts.cookie;

  const robots = opts.ignoreRobots
    ? { checked: false, allowed: true }
    : await checkRobots(requested, { timeoutMs, userAgent, cookie });

  if (!robots.allowed) {
    throw new ToolError(
      `Blocked by robots.txt for ${requested.pathname}${robots.rule ? ` (${robots.rule})` : ""}. ` +
        "Use --ignore-robots only on targets you own or are authorized to test.",
    );
  }

  const fetchPage = (ua: string) =>
    fetchResource(requested.href, {
      timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      userAgent: ua,
      cookie,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    });

  let usedUserAgent = userAgent ?? DEFAULT_USER_AGENT;
  let userAgentFallback = false;
  let page: FetchedResource;
  try {
    page = await fetchPage(usedUserAgent);
  } catch (err) {
    throw err instanceof ToolError ? err : new ToolError(String(err));
  }

  // Some sites reject non-browser clients (bot protection). Unless the user
  // chose a UA, retry once with a browser-like one and record it.
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

  if (page.status >= 400) {
    throw new ToolError(`HTTP ${page.status} for ${page.url}${httpStatusHint(page.status)}`);
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

  const scriptAssets = discovered.slice(0, maxScripts);

  const inlineScripts = parsed.scripts
    .filter((s) => !s.src && s.inline && s.inline.trim() !== "")
    .map((s, i) => ({ path: `inline[${i + 1}]`, content: s.inline as string }));

  // ---- Fetch + analyze ----
  const files: WebFileAnalysis[] = [];
  const findingStrings: FindingString[] = [];
  const assets: WebAsset[] = [];
  const scriptTexts: string[] = [];

  const fetched = await mapLimit(scriptAssets, 4, async (asset) => {
    if (byteBudget <= 0) {
      return {
        asset,
        error: "skipped (total byte budget reached)",
        skipped: true,
        text: null as string | null,
        bytes: 0,
        status: null as number | null,
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
        };
      }
      return {
        asset,
        error: undefined,
        skipped: false,
        text: res.text,
        bytes: res.bytes,
        status: res.status,
      };
    } catch (err) {
      return {
        asset,
        error: err instanceof Error ? err.message : String(err),
        skipped: false,
        text: null as string | null,
        bytes: 0,
        status: null as number | null,
      };
    }
  });

  let fetchErrors = 0;
  let skippedAssets = 0;
  let jsBytes = 0;
  let scriptsAnalyzed = 0;

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
      ...(item.error ? { error: item.error } : {}),
    });

    if (!ok || item.text === null) {
      if (item.skipped) skippedAssets++;
      else fetchErrors++;
      continue;
    }

    if (jsBytes + item.bytes > totalLimit) {
      skippedAssets++;
      assets[assets.length - 1].error = "skipped (total byte budget reached)";
      continue;
    }

    jsBytes += item.bytes;
    // Bound the text kept for framework detection on very large bundles.
    scriptTexts.push(item.text.slice(0, 1_000_000));
    assets[assets.length - 1].analyzed = true;
    scriptsAnalyzed++;

    const file = await analyzeScript(item.text, asset.url, pathOf(asset.url), {
      minLength,
      limit,
    });
    files.push(toPublicFile(file));
    findingStrings.push({ path: file.path, strings: file.findings });
  }

  // Inline scripts are analyzed too (they often hold config and keys).
  for (const inline of inlineScripts) {
    const url = `${page.url}#${inline.path}`;
    const file = await analyzeScript(inline.content, url, inline.path, { minLength, limit });
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

  const frameworks = detectFrameworks({
    html: page.text,
    scripts: scriptTexts,
    urls: discovered.map((d) => d.url),
  });

  const totalStrings = files.reduce((acc, f) => acc + f.stringTotal, 0);

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
      redirects:
        page.url === requested.href ? [] : [{ from: requested.href, to: page.url }],
      robots,
    },
    frameworks,
    assets,
    files,
    endpoints: findings.endpoints,
    routes: findings.routes,
    keys: findings.keys,
    featureFlags: findings.featureFlags,
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

// ---------------------------------------------------------------------------
// Per-script analysis
// ---------------------------------------------------------------------------

interface ScriptAnalysisFile extends WebFileAnalysis {
  findings: ExtractedString[];
}

/** Drops the internal `findings` list before a file enters the report. */
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
