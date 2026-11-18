// Source Map project unpacker and tree reconstructor.
// Recreates the original source code hierarchy from source maps in .js, .map, or .asar files.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";
import {
  loadSourceMapPayload,
  type RawSourceMap,
} from "./sourcemap.js";
import { loadAsar, extractAsarFile } from "./asar.js";
import { globToRegExp } from "./web-download.js";

export interface UnpackSourceFile {
  /** Original path recorded in the source map (e.g. "webpack:///src/app.tsx"). */
  sourcePath: string;
  /** Sanitized relative filesystem path (e.g. "src/app.tsx"). */
  relativePath: string;
  /** Content of the original source file. */
  content: string;
  /** The bundle, map or archive entry that provided this file. */
  sourceOrigin?: string;
}

export interface UnpackSelector {
  /** Filter by glob pattern against the relative or original path (e.g. "*.tsx", "src/**"). */
  match?: string;
  /** Exact relative paths or basenames to extract. */
  paths?: string[];
  /** Exclude third-party dependencies (paths containing node_modules). Default: false. */
  excludeNodeModules?: boolean;
}

export interface UnpackSummary {
  target: string;
  targetType: "map" | "js" | "asar";
  outDir: string;
  sourceMapsFound: number;
  filesRestored: number;
  bytes: number;
  skippedUnsafe: number;
  skippedNodeModules: number;
  entries: string[];
}

/**
 * Sanitizes an arbitrary sourcemap source path into a safe, traversal-free relative path.
 * Strips bundler URL schemes (webpack://, vite://, turbopack://, file://), query strings,
 * drive letters, and directory traversal tokens ('..').
 */
export function sanitizeSourcePath(raw: string, fallbackIndex = 0): string {
  let s = (raw ?? "").trim();
  if (!s) return `source_${fallbackIndex}.js`;

  // Strip query parameters (not starting with extension dot) and hashes
  s = s.replace(/#.*$/, "");
  s = s.replace(/\?(?!\.)[^/]*$/, "");

  // Strip bundler protocol schemes:
  // webpack://[name]/, webpack://_N_E/, webpack://app/, webpack:///, vite:///, turbopack:///, file:///, https?://domain/
  s = s.replace(/^(?:webpack|vite|turbopack|file):\/\/(?:\[[^\]]+\]\/|[^/]+\/|\/)?/i, "");
  s = s.replace(/^https?:\/\/[^/]+\//i, "");

  // Strip bundler pseudo-roots like [project]/, [root]/, (app-pages)/
  s = s.replace(/^(?:\[[^\]]+\]|\([^)]+\))\//, "");

  // Normalize Windows separators and drive letters
  s = s.replace(/\\/g, "/");
  s = s.replace(/^[a-zA-Z]:\//, "");

  // Remove leading slashes and relative current directory tokens
  s = s.replace(/^\/+/, "");
  s = s.replace(/^(\.\/)+/, "");

  const rawSegments = s.split("/").filter(Boolean);
  const segments: string[] = [];

  for (const seg of rawSegments) {
    const trimmed = seg.trim();
    if (!trimmed || trimmed === "." || trimmed === "..") continue;
    // Replace forbidden characters on common filesystems (: * ? " < > |)
    const sanitized = trimmed.replace(/[:*?"<>|]/g, "_");
    if (sanitized) segments.push(sanitized);
  }

  if (segments.length === 0) {
    return `source_${fallbackIndex}.js`;
  }

  return segments.join("/");
}

/**
 * Extracts and decodes source files from a parsed RawSourceMap object according to selector criteria.
 */
export function extractFilesFromSourceMap(
  map: RawSourceMap,
  selector: UnpackSelector = {},
  origin?: string,
): { files: UnpackSourceFile[]; skippedNodeModules: number; skippedUnsafe: number } {
  const sources = Array.isArray(map.sources) ? map.sources : [];
  const sourcesContent = Array.isArray(map.sourcesContent) ? map.sourcesContent : [];

  const globRe = selector.match ? globToRegExp(selector.match) : null;
  const hasPaths = !!selector.paths && selector.paths.length > 0;
  const excludeNodeModules = selector.excludeNodeModules ?? false;

  const files: UnpackSourceFile[] = [];
  let skippedNodeModules = 0;
  let skippedUnsafe = 0;

  for (let i = 0; i < sources.length; i++) {
    const rawPath = sources[i];
    const content = sourcesContent[i];

    // Only extract when content is present and is a string
    if (typeof content !== "string") continue;

    const relPath = sanitizeSourcePath(rawPath, i + 1);
    if (!relPath) {
      skippedUnsafe++;
      continue;
    }

    if (excludeNodeModules && relPath.includes("node_modules")) {
      skippedNodeModules++;
      continue;
    }

    const basename = path.posix.basename(relPath);
    if (hasPaths) {
      const match = selector.paths!.some(
        (p) => p === relPath || p === basename || p === rawPath,
      );
      if (!match) continue;
    }

    if (globRe) {
      if (!globRe.test(relPath) && !globRe.test(basename) && !globRe.test(rawPath)) {
        continue;
      }
    }

    files.push({
      sourcePath: rawPath,
      relativePath: relPath,
      content,
      sourceOrigin: origin,
    });
  }

  return { files, skippedNodeModules, skippedUnsafe };
}

/**
 * Unpacks the original source files from a .js bundle, .map file, or .asar archive to `outDir`.
 */
export async function unpackSourceMap(
  targetPath: string,
  outDir: string,
  selector: UnpackSelector = {},
): Promise<UnpackSummary> {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedOutDir = path.resolve(outDir);

  const isAsar = /\.asar$/i.test(resolvedTarget);
  const isMap = /\.map$/i.test(resolvedTarget);

  let targetType: "map" | "js" | "asar" = "js";
  if (isAsar) targetType = "asar";
  else if (isMap) targetType = "map";

  const allFiles: UnpackSourceFile[] = [];
  let sourceMapsFound = 0;
  let totalSkippedNodeModules = 0;
  let totalSkippedUnsafe = 0;

  if (isAsar) {
    const { archive, buffer } = await loadAsar(resolvedTarget);

    for (const entry of archive.entries) {
      if (entry.unpacked || entry.size === 0) continue;

      if (/\.map$/i.test(entry.path)) {
        try {
          const slice = extractAsarFile(buffer, archive, entry);
          const map = JSON.parse(slice.toString("utf8")) as RawSourceMap;
          if (map && Array.isArray(map.sources)) {
            sourceMapsFound++;
            const { files, skippedNodeModules, skippedUnsafe } =
              extractFilesFromSourceMap(map, selector, entry.path);
            allFiles.push(...files);
            totalSkippedNodeModules += skippedNodeModules;
            totalSkippedUnsafe += skippedUnsafe;
          }
        } catch {
          /* ignore corrupt map entry */
        }
      } else if (/\.(?:js|mjs|cjs)$/i.test(entry.path)) {
        try {
          const slice = extractAsarFile(buffer, archive, entry);
          const text = slice.toString("utf8");
          const payload = await loadSourceMapPayload(text);
          if (payload?.map) {
            sourceMapsFound++;
            const { files, skippedNodeModules, skippedUnsafe } =
              extractFilesFromSourceMap(payload.map, selector, entry.path);
            allFiles.push(...files);
            totalSkippedNodeModules += skippedNodeModules;
            totalSkippedUnsafe += skippedUnsafe;
          }
        } catch {
          /* ignore */
        }
      }
    }
  } else if (isMap) {
    let mapText: string;
    try {
      mapText = await readFile(resolvedTarget, "utf8");
    } catch (err) {
      throw new ToolError(`Failed to read source map ${targetPath}: ${err}`);
    }

    let map: RawSourceMap;
    try {
      map = JSON.parse(mapText) as RawSourceMap;
    } catch (err) {
      throw new ToolError(`Invalid JSON in source map ${targetPath}: ${err}`);
    }

    sourceMapsFound++;
    const { files, skippedNodeModules, skippedUnsafe } =
      extractFilesFromSourceMap(map, selector, path.basename(resolvedTarget));
    allFiles.push(...files);
    totalSkippedNodeModules += skippedNodeModules;
    totalSkippedUnsafe += skippedUnsafe;
  } else {
    // Standard JS file or bundle
    let jsText: string;
    try {
      jsText = await readFile(resolvedTarget, "utf8");
    } catch (err) {
      throw new ToolError(`Failed to read file ${targetPath}: ${err}`);
    }

    const payload = await loadSourceMapPayload(jsText, resolvedTarget);
    if (!payload?.map) {
      // Check if a companion .map file exists (e.g. targetPath + ".map")
      const companionPath = `${resolvedTarget}.map`;
      let companionMap: RawSourceMap | null = null;
      try {
        const text = await readFile(companionPath, "utf8");
        companionMap = JSON.parse(text) as RawSourceMap;
      } catch {
        // no companion
      }

      if (companionMap) {
        sourceMapsFound++;
        const { files, skippedNodeModules, skippedUnsafe } =
          extractFilesFromSourceMap(companionMap, selector, path.basename(companionPath));
        allFiles.push(...files);
        totalSkippedNodeModules += skippedNodeModules;
        totalSkippedUnsafe += skippedUnsafe;
      } else {
        throw new ToolError(
          `No source map found in ${targetPath} (no inline sourceMappingURL or companion .map file).`,
        );
      }
    } else {
      sourceMapsFound++;
      const { files, skippedNodeModules, skippedUnsafe } =
        extractFilesFromSourceMap(payload.map, selector, path.basename(resolvedTarget));
      allFiles.push(...files);
      totalSkippedNodeModules += skippedNodeModules;
      totalSkippedUnsafe += skippedUnsafe;
    }
  }

  // Deduplicate files by relativePath (keep the first or largest)
  const uniqueFiles = new Map<string, UnpackSourceFile>();
  for (const f of allFiles) {
    if (!uniqueFiles.has(f.relativePath)) {
      uniqueFiles.set(f.relativePath, f);
    }
  }

  let bytesWritten = 0;
  const writtenEntries: string[] = [];

  for (const file of uniqueFiles.values()) {
    const dest = path.join(resolvedOutDir, ...file.relativePath.split("/"));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content, "utf8");
    bytesWritten += Buffer.byteLength(file.content, "utf8");
    writtenEntries.push(file.relativePath);
  }

  return {
    target: targetPath,
    targetType,
    outDir: resolvedOutDir,
    sourceMapsFound,
    filesRestored: writtenEntries.length,
    bytes: bytesWritten,
    skippedUnsafe: totalSkippedUnsafe,
    skippedNodeModules: totalSkippedNodeModules,
    entries: writtenEntries.sort(),
  };
}
