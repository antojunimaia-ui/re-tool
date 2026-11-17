// Reading .asar files (Electron's archive format).
//
// Format: a Chromium Pickle prefix (8 or 16 bytes) followed by the JSON header
// (the file tree with size/offset) and then the file bodies. Offsets in the
// JSON are relative to the end of the JSON header (after any whitespace
// padding). The prefix length varies between writers, so the parser locates
// the JSON object dynamically and uses a balanced-brace scanner to find its
// end — this makes the reader tolerant to prefix variations.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";
import { scanSource, type ScanReport } from "./report.js";
import type { FileSource } from "./index.js";
import type { FormatInfo } from "./format.js";
import type { ObfuscatorFinding } from "./obfuscators.js";
import type { SourceMapInfo } from "./sourcemap.js";

export interface AsarEntry {
  /** Caminho dentro do arquivo (separado por "/", sem raiz). */
  path: string;
  size: number;
  /** Offset absoluto dentro do .asar (headerEnd + offset relativo). */
  offset: number;
  /** true quando o conteúdo reside fora do arquivo (diretório .unpacked). */
  unpacked: boolean;
}

export interface AsarArchive {
  path: string;
  /** Offset (absoluto) onde o corpo dos arquivos começa. */
  headerEnd: number;
  entries: AsarEntry[];
  totalBytes: number;
}

export interface AsarHeader {
  header: Record<string, unknown>;
  headerEnd: number;
}

function findJsonEnd(buffer: Buffer, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < buffer.length; i++) {
    const c = buffer[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92 /* \ */) escaped = true;
      else if (c === 34 /* " */) inString = false;
      continue;
    }
    if (c === 34) {
      inString = true;
      continue;
    }
    if (c === 123 /* { */) depth++;
    else if (c === 125 /* } */) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  throw new ToolError("Unterminated ASAR header (unbalanced braces).");
}

export function parseAsarHeader(buffer: Buffer): AsarHeader {
  if (buffer.length < 8) {
    throw new ToolError("ASAR file too small for a header.");
  }

  // The JSON header may be preceded by a Chromium Pickle prefix (8 or 16
  // bytes, depending on the writer). Instead of hardcoding the offset, find
  // the JSON object dynamically (searching from byte 8 onward).
  const jsonStart = buffer.indexOf(0x7b /* { */, 8);
  if (jsonStart === -1) {
    throw new ToolError("Invalid ASAR header: JSON object not found.");
  }
  const jsonEnd = findJsonEnd(buffer, jsonStart);
  const headerText = buffer.toString("utf8", jsonStart, jsonEnd);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(headerText) as Record<string, unknown>;
  } catch (err) {
    throw new ToolError(
      `Invalid ASAR header: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Some writers pad the JSON header with spaces up to a 4-byte boundary;
  // file data then starts at the aligned offset. Detect whitespace padding.
  let headerEnd = jsonEnd;
  const aligned = (jsonEnd + 3) & ~3;
  if (aligned > jsonEnd && aligned <= buffer.length) {
    let isPadding = true;
    for (let i = jsonEnd; i < aligned; i++) {
      const b = buffer[i];
      if (b !== 0x20 /* space */ && b !== 0x00 /* NUL */) {
        isPadding = false;
        break;
      }
    }
    if (isPadding) headerEnd = aligned;
  }

  return { header, headerEnd };
}

function walkFiles(node: unknown, prefix: string, entries: AsarEntry[]): void {
  const files = (node as { files?: Record<string, unknown> })?.files;
  if (!files || typeof files !== "object") return;

  for (const [name, info] of Object.entries(files)) {
    const child = info as {
      files?: Record<string, unknown>;
      size?: number | string;
      offset?: number | string;
      unpacked?: boolean;
    } | null;
    if (!child) continue;

    const fullPath = prefix ? `${prefix}/${name}` : name;

    if (child.files && typeof child.files === "object") {
      walkFiles(child, fullPath, entries);
      continue;
    }

    const size = Number(child.size ?? 0);
    const unpacked = Boolean(child.unpacked);
    const offsetRaw = child.offset;
    entries.push({
      path: fullPath,
      size,
      offset: unpacked || offsetRaw === undefined ? 0 : Number(offsetRaw),
      unpacked,
    });
  }
}

export async function loadAsar(filePath: string): Promise<{ archive: AsarArchive; buffer: Buffer }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    throw new ToolError(`File not found: ${filePath}`);
  }

  const { header, headerEnd } = parseAsarHeader(buffer);
  const entries: AsarEntry[] = [];
  walkFiles(header, "", entries);

  const totalBytes = entries.reduce(
    (acc, e) => acc + (e.unpacked ? 0 : e.size),
    0,
  );

  return { archive: { path: filePath, headerEnd, entries, totalBytes }, buffer };
}

/** Recorta o conteúdo de uma entrada do .asar a partir do buffer completo. */
export function extractAsarFile(
  buffer: Buffer,
  archive: AsarArchive,
  entry: AsarEntry,
): Buffer {
  if (entry.unpacked) {
    throw new ToolError(`Unpacked entry (no content in .asar): ${entry.path}`);
  }
  const start = archive.headerEnd + entry.offset;
  return buffer.subarray(start, start + entry.size);
}

// ---------------------------------------------------------------------------
// Extração para disco
// ---------------------------------------------------------------------------

export interface ExtractAsarSelector {
  /** Exact entry paths to extract (empty/omitted = all, unless `match`). */
  paths?: string[];
  /** Glob pattern (e.g. "*.js") to select entries. */
  match?: string;
}

export interface AsarExtractSummary {
  extracted: number;
  matched: number;
  bytes: number;
  skippedUnpacked: number;
  skippedUnsafe: number;
  entries: string[];
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Splits an archive path into safe local segments (no traversal, no drive). */
function safeSegments(entryPath: string): string[] {
  const segments: string[] = [];
  for (const raw of entryPath.split("/")) {
    const seg = raw.trim();
    if (!seg || seg === "." || seg === "..") continue;
    if (seg.includes("\\") || seg.includes(":")) return [];
    segments.push(seg);
  }
  return segments;
}

/**
 * Extracts `.asar` entries to `outDir`.
 *
 * - No selector → all entries.
 * - `selector.paths` → only those exact paths.
 * - `selector.match` → only entries matching the glob pattern.
 *
 * Unpacked entries (`.unpacked/` directory) and unsafe paths are skipped.
 */
export async function extractAsarFiles(
  filePath: string,
  outDir: string,
  selector: ExtractAsarSelector = {},
): Promise<AsarExtractSummary> {
  const { archive, buffer } = await loadAsar(filePath);

  const globRe = selector.match ? globToRegExp(selector.match) : null;
  const hasPaths = !!selector.paths && selector.paths.length > 0;

  const include = (e: AsarEntry): boolean => {
    if (hasPaths) return selector.paths!.includes(e.path);
    if (globRe) return globRe.test(e.path);
    return true;
  };

  let extracted = 0;
  let matched = 0;
  let bytes = 0;
  let skippedUnpacked = 0;
  let skippedUnsafe = 0;
  const entries: string[] = [];

  for (const e of archive.entries) {
    if (!include(e)) continue;
    matched++;
    if (e.unpacked) {
      skippedUnpacked++;
      continue;
    }
    const segments = safeSegments(e.path);
    if (segments.length === 0) {
      skippedUnsafe++;
      continue;
    }
    const dest = path.join(outDir, ...segments);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, extractAsarFile(buffer, archive, e));
    extracted++;
    bytes += e.size;
    entries.push(e.path);
  }

  return { extracted, matched, bytes, skippedUnpacked, skippedUnsafe, entries };
}

// ---------------------------------------------------------------------------
// Análise de um app Electron (percorre bundles JS dentro do .asar)
// ---------------------------------------------------------------------------

export interface AnalyzeAsarOptions {
  /** Strings mais curtas que isso são ignoradas. Padrão: 4. */
  minLength?: number;
  /** Máximo de strings por arquivo no relatório. Padrão: 50. */
  limit?: number;
  /** Máximo de arquivos JS analisados. Padrão: 300. */
  maxFiles?: number;
  /** Tamanho máximo (bytes) de um arquivo JS analisado. Padrão: 20 MB. */
  maxJsBytes?: number;
}

export interface AsarFileAnalysis {
  path: string;
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

export interface ElectronReport {
  schema: "re-tool/electron-report@1";
  target: string;
  asar: {
    totalFiles: number;
    totalBytes: number;
    jsFilesAnalyzed: number;
    skipped: number;
  };
  files: AsarFileAnalysis[];
  summary: {
    totalStrings: number;
    base64Like: number;
    hexEscaped: number;
    highEntropy: number;
    obfuscatorFiles: number;
    webpackFiles: number;
  };
}

export async function analyzeAsarApp(
  filePath: string,
  opts: AnalyzeAsarOptions = {},
): Promise<ElectronReport> {
  const { archive, buffer } = await loadAsar(filePath);

  const minLength = opts.minLength ?? 4;
  const limit = Math.max(1, opts.limit ?? 50);
  const maxFiles = opts.maxFiles ?? 300;
  const maxJsBytes = opts.maxJsBytes ?? 20 * 1024 * 1024;

  const jsEntries = archive.entries
    .filter(
      (e) =>
        !e.unpacked &&
        e.size > 0 &&
        e.size <= maxJsBytes &&
        /\.(?:js|mjs|cjs)$/i.test(e.path),
    )
    .slice(0, maxFiles);

  const files: AsarFileAnalysis[] = [];
  const skipped = archive.entries.length - jsEntries.length;

  for (const entry of jsEntries) {
    const slice = extractAsarFile(buffer, archive, entry);
    const content = slice.toString("utf8");
    const source: FileSource = {
      path: `${filePath}!/${entry.path}`,
      content,
      lines: content.split("\n"),
    };

    const report = await scanSource(source, { minLength, limit });

    files.push({
      path: entry.path,
      size: entry.size,
      format: report.format,
      parseError: report.parseError,
      webpackModules: report.summary.webpackModules,
      obfuscators: report.obfuscators,
      sourceMap: report.sourceMap,
      strings: report.strings,
      stringTotal: report.summary.totalStrings,
      stringChars: report.summary.totalStringChars,
    });
  }

  const highEntropyThreshold = 4.5;
  const summary = {
    totalStrings: files.reduce((a, f) => a + f.stringTotal, 0),
    base64Like: files.reduce(
      (a, f) => a + f.strings.filter((s) => s.encoding === "base64-like").length,
      0,
    ),
    hexEscaped: files.reduce(
      (a, f) => a + f.strings.filter((s) => s.encoding === "hex-escaped").length,
      0,
    ),
    highEntropy: files.reduce(
      (a, f) =>
        a +
        f.strings.filter((s) => s.length >= 16 && s.entropy >= highEntropyThreshold).length,
      0,
    ),
    obfuscatorFiles: files.filter((f) => f.obfuscators.length > 0).length,
    webpackFiles: files.filter((f) => f.webpackModules > 0).length,
  };

  return {
    schema: "re-tool/electron-report@1",
    target: filePath,
    asar: {
      totalFiles: archive.entries.length,
      totalBytes: archive.totalBytes,
      jsFilesAnalyzed: files.length,
      skipped,
    },
    files,
    summary,
  };
}
