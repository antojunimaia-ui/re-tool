// HTML entity decoding, attribute parsing and asset discovery.

export type WebAssetType =
  | "script"
  | "inline"
  | "modulepreload"
  | "preload"
  | "stylesheet"
  | "other";

export interface ParsedHtml {
  title: string | null;
  baseUrl: string;
  meta: Record<string, string>;
  scripts: { src: string | null; inline: string | null; type: string | null }[];
  links: { href: string; rel: string; as: string | null }[];
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = u.pathname === "/" ? "/" : u.pathname;
    return u.search ? `${p}${u.search}` : p;
  } catch {
    return url;
  }
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

export function resolveAssetUrl(raw: string, baseUrl: string): string | null {
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
