// Download and disk-extraction utilities for web targets.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WebAssetType } from "./web-html.js";

export type WebDownloadType = WebAssetType | "html";

export interface WebDownloadFile {
  path: string;
  url?: string;
  content: string | Buffer;
  type: WebDownloadType;
}

export interface WebDownloadSelector {
  /** Exact relative paths or basenames to download (e.g. ["main.js", "style.css"]). */
  paths?: string[];
  /** Glob pattern to match against paths or basenames (e.g. "*.js"). */
  match?: string;
}

export interface WebDownloadSummary {
  downloaded: number;
  matched: number;
  bytes: number;
  skippedUnsafe: number;
  entries: string[];
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Splits and sanitizes a URL path or file path into safe local filesystem segments
 * (prevents path traversal, drive specifiers, and illegal filesystem characters).
 */
export function safeWebSegments(entryPath: string): string[] {
  // Strip URL query/hash if present (query not followed by dot, e.g. ?v=123, #hash)
  let clean = entryPath.replace(/#[^/]*$/, "").trim();
  clean = clean.replace(/\?(?!\.)[^/]*$/, "");
  clean = clean.replace(/\\/g, "/");
  clean = clean.replace(/^\/+/, "");

  if (clean === "" || clean.endsWith("/")) {
    clean = `${clean}index.html`;
  }

  const rawSegments = clean.split("/").filter(Boolean);
  const segments: string[] = [];

  for (const seg of rawSegments) {
    const s = seg.trim();
    if (!s || s === "." || s === "..") continue;
    // Replace illegal characters (: * ? " < > |) with underscores
    const sanitized = s.replace(/[:*?"<>|]/g, "_");
    if (!sanitized) continue;
    segments.push(sanitized);
  }

  return segments;
}

/**
 * Writes collected web files to `outDir` according to the given selector.
 */
export async function downloadWebFiles(
  files: WebDownloadFile[],
  outDir: string,
  selector: WebDownloadSelector = {},
): Promise<WebDownloadSummary> {
  const globRe = selector.match ? globToRegExp(selector.match) : null;
  const hasPaths = !!selector.paths && selector.paths.length > 0;

  const include = (f: WebDownloadFile, segments: string[]): boolean => {
    const fullRelative = segments.join("/");
    const basename = segments.at(-1) ?? "";

    if (hasPaths) {
      return selector.paths!.some(
        (p) =>
          p === fullRelative ||
          p === basename ||
          p === f.path ||
          (f.url && p === f.url),
      );
    }
    if (globRe) {
      return (
        globRe.test(fullRelative) ||
        globRe.test(basename) ||
        globRe.test(f.path)
      );
    }
    return true;
  };

  let downloaded = 0;
  let matched = 0;
  let bytes = 0;
  let skippedUnsafe = 0;
  const entries: string[] = [];

  for (const file of files) {
    const segments = safeWebSegments(file.path);
    if (segments.length === 0) {
      skippedUnsafe++;
      continue;
    }

    if (!include(file, segments)) continue;
    matched++;

    const dest = path.join(outDir, ...segments);
    await mkdir(path.dirname(dest), { recursive: true });

    const contentBuffer =
      typeof file.content === "string"
        ? Buffer.from(file.content, "utf8")
        : file.content;

    await writeFile(dest, contentBuffer);
    downloaded++;
    bytes += contentBuffer.byteLength;
    entries.push(segments.join("/"));
  }

  return { downloaded, matched, bytes, skippedUnsafe, entries };
}
