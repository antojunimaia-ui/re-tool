// Findings: endpoints, routes, keys, feature flags from strings and network captures.
import type { ExtractedString } from "./strings.js";

export const NOISE_HOSTS = [
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

export const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'`<>\\]+/gi;
export const API_PATH_RE =
  /^\/(?:api|v[1-9]\d*|graphql|gql|rest|rpc|trpc|auth|oauth2?|session|ws|socket|internal|admin)\b/i;

export const ASSET_EXT_RE =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|pdf|xml|txt|wasm|html?)$/i;

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

export const KEY_PATTERNS: { kind: string; re: RegExp }[] = [
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

export const FLAG_PATTERNS: RegExp[] = [
  /\b((?:FEATURE|ENABLE|ENABLED|FF|FLAG|EXPERIMENT|BETA|ROLLOUT)_[A-Z0-9_]{2,})\b/g,
  /\b((?:feature|enable|flag|experiment|beta)[A-Z][A-Za-z0-9]{2,})\b/g,
  /\b(feature_flag|feature_flags|featureFlag|featureFlags)\b/g,
];

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

/**
 * Merges XHR/fetch request URLs captured by the browser into the endpoint
 * list. Same-origin API paths become `relative` entries and cross-origin calls stay absolute.
 */
export function withNetworkEndpoints(
  endpoints: WebEndpoint[],
  network: { url: string; resourceType: string }[],
  pageUrl: string,
  maxEndpoints: number,
): WebEndpoint[] {
  if (network.length === 0) return endpoints;

  const byKey = new Map<string, WebEndpoint>();
  for (const e of endpoints) byKey.set(`${e.kind}:${e.value}`, e);

  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* leave empty: every request stays absolute */
  }

  const add = (kind: EndpointKind, value: string) => {
    const key = `${kind}:${value}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    byKey.set(key, { value, kind, count: 1, source: "network", line: 0 });
  };

  for (const res of network) {
    if (res.resourceType !== "XHR" && res.resourceType !== "Fetch") continue;

    let url: URL;
    try {
      url = new URL(res.url);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (url.username !== "" || url.password !== "") continue;

    const path = `${url.pathname}${url.search}`;
    if (url.origin === origin && API_PATH_RE.test(path) && !ASSET_EXT_RE.test(path)) {
      add("relative", path);
    } else {
      add("http", res.url);
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, maxEndpoints);
}
