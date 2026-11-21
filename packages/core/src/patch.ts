// Packaging and patching Electron ASAR archives.
import { readFile, writeFile, mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { ToolError } from "./errors.js";
import { loadAsar, extractAsarFile, type AsarArchive, type AsarEntry } from "./asar.js";

export interface AsarPayloadItem {
  path: string;
  buffer: Buffer;
  unpacked?: boolean;
}

export interface PackAsarOptions {
  /** Glob pattern for files to keep in `<dest>.unpacked/` (e.g. "*.node"). */
  unpack?: string;
  /** Files or folders to ignore (default: .git, .DS_Store, Thumbs.db). */
  ignore?: string[];
}

export interface PackAsarResult {
  asarPath: string;
  unpackedDir?: string;
  totalFiles: number;
  totalBytes: number;
  unpackedFiles: number;
  entries: string[];
}

export interface PatchTextRule {
  file: string;
  search: string | RegExp;
  replace: string;
}

export interface PatchAppendRule {
  file: string;
  content: string;
}

export interface PatchPrependRule {
  file: string;
  content: string;
}

export interface PatchAsarOptions {
  /** Output file path. If omitted or equal to source, patches in-place. */
  out?: string;
  /** When patching in-place, creates `<asarPath>.bak` (default: true). */
  backup?: boolean;
  /** Map of entry paths inside ASAR to local file paths or Buffers. */
  replaceFiles?: Record<string, string | Buffer>;
  /** Search and replace inside specific text files in the ASAR. */
  replaceText?: PatchTextRule[];
  /** Append text to specific files in the ASAR. */
  append?: PatchAppendRule[];
  /** Prepend text to specific files in the ASAR. */
  prepend?: PatchPrependRule[];
  /** List of entry paths to remove from the ASAR. */
  removeFiles?: string[];
  /** Pattern for unpacked files when repacking. */
  unpack?: string;
}

export interface PatchAsarResult {
  asarPath: string;
  outPath: string;
  backupPath?: string;
  modified: string[];
  added: string[];
  removed: string[];
  totalFiles: number;
  totalBytes: number;
  unpackedFiles: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Builds a Chromium Pickle ASAR buffer from a list of payload items.
 */
export function buildAsarBuffer(items: AsarPayloadItem[]): Buffer {
  const headerFiles: Record<string, unknown> = {};
  const bodyBuffers: Buffer[] = [];
  let currentOffset = 0n;

  for (const item of items) {
    const parts = item.path.split("/");
    let cur: any = headerFiles;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      cur[seg] ??= { files: {} };
      cur = cur[seg].files;
    }

    const fileName = parts[parts.length - 1];
    if (item.unpacked) {
      cur[fileName] = {
        size: item.buffer.length,
        unpacked: true,
      };
    } else {
      cur[fileName] = {
        size: item.buffer.length,
        offset: currentOffset.toString(),
      };
      currentOffset += BigInt(item.buffer.length);
      bodyBuffers.push(item.buffer);
    }
  }

  const jsonStr = JSON.stringify({ files: headerFiles });
  const jsonBuf = Buffer.from(jsonStr, "utf8");
  const padding = (4 - (jsonBuf.length % 4)) % 4;
  const payloadSize = 4 + jsonBuf.length + padding;

  // headerPickle: payloadSize (UInt32) + jsonLen (UInt32) + jsonBuf + padding
  const headerPickle = Buffer.alloc(4 + payloadSize);
  headerPickle.writeUInt32LE(payloadSize, 0);
  headerPickle.writeUInt32LE(jsonBuf.length, 4);
  jsonBuf.copy(headerPickle, 8);

  // sizePickle: 4 (UInt32 payload size) + headerPickle.length (UInt32)
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);

  return Buffer.concat([sizePickle, headerPickle, ...bodyBuffers]);
}

/**
 * Recursively scans a directory and collects all files with normalized "/" paths.
 */
async function collectFiles(
  dir: string,
  baseDir: string,
  ignoreList: Set<string>,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    if (ignoreList.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(fullPath, baseDir, ignoreList)));
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, "/");
      results.push(rel);
    }
  }

  return results;
}

/**
 * Packs a directory into an Electron .asar file.
 */
export async function packAsar(
  sourceDir: string,
  destAsarPath: string,
  opts: PackAsarOptions = {},
): Promise<PackAsarResult> {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedDest = path.resolve(destAsarPath);

  try {
    const s = await stat(resolvedSource);
    if (!s.isDirectory()) {
      throw new ToolError(`Source path is not a directory: ${sourceDir}`);
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError(`Cannot read directory: ${sourceDir}`);
  }

  const ignoreList = new Set(opts.ignore ?? [".git", ".DS_Store", "Thumbs.db"]);
  const relPaths = await collectFiles(resolvedSource, resolvedSource, ignoreList);
  relPaths.sort();

  const unpackRegex = opts.unpack ? globToRegExp(opts.unpack) : null;
  const items: AsarPayloadItem[] = [];
  const unpackedDir = `${resolvedDest}.unpacked`;
  let unpackedFiles = 0;
  let totalBytes = 0;

  for (const rel of relPaths) {
    const fullPath = path.join(resolvedSource, ...rel.split("/"));
    const buffer = await readFile(fullPath);
    const isUnpacked = unpackRegex ? unpackRegex.test(rel) || unpackRegex.test(path.basename(rel)) : false;

    if (isUnpacked) {
      unpackedFiles++;
      const destUnpackedFile = path.join(unpackedDir, ...rel.split("/"));
      await mkdir(path.dirname(destUnpackedFile), { recursive: true });
      await copyFile(fullPath, destUnpackedFile);
      items.push({ path: rel, buffer, unpacked: true });
    } else {
      totalBytes += buffer.length;
      items.push({ path: rel, buffer, unpacked: false });
    }
  }

  const archiveBuf = buildAsarBuffer(items);
  await mkdir(path.dirname(resolvedDest), { recursive: true });
  await writeFile(resolvedDest, archiveBuf);

  return {
    asarPath: resolvedDest,
    unpackedDir: unpackedFiles > 0 ? unpackedDir : undefined,
    totalFiles: items.length,
    totalBytes,
    unpackedFiles,
    entries: items.map((i) => i.path),
  };
}

/**
 * Modifies and repacks an existing .asar file.
 */
export async function patchAsar(
  asarPath: string,
  opts: PatchAsarOptions = {},
): Promise<PatchAsarResult> {
  const resolvedAsar = path.resolve(asarPath);
  const outPath = path.resolve(opts.out ?? asarPath);
  const isInPlace = resolvedAsar === outPath;

  const { archive, buffer } = await loadAsar(resolvedAsar);

  // Read existing files into a map
  const fileMap = new Map<string, { buffer: Buffer; unpacked: boolean }>();
  const originalFiles = new Set<string>();

  for (const entry of archive.entries) {
    originalFiles.add(entry.path);
    if (entry.unpacked) {
      // Unpacked files live in `<asarPath>.unpacked/`
      const unpackedSource = path.join(path.dirname(resolvedAsar), `${path.basename(resolvedAsar)}.unpacked`, ...entry.path.split("/"));
      let itemBuf: Buffer;
      try {
        itemBuf = await readFile(unpackedSource);
      } catch {
        itemBuf = Buffer.alloc(0);
      }
      fileMap.set(entry.path, { buffer: itemBuf, unpacked: true });
    } else {
      const slice = extractAsarFile(buffer, archive, entry);
      fileMap.set(entry.path, { buffer: Buffer.from(slice), unpacked: false });
    }
  }

  const modifiedSet = new Set<string>();
  const addedSet = new Set<string>();
  const removedSet = new Set<string>();

  // 1. Process removals
  if (opts.removeFiles) {
    for (const rem of opts.removeFiles) {
      const normalized = rem.replace(/\\/g, "/").trim();
      if (fileMap.delete(normalized)) {
        removedSet.add(normalized);
      }
    }
  }

  // 2. Process file replacements / additions
  if (opts.replaceFiles) {
    for (const [entryRelPath, localSource] of Object.entries(opts.replaceFiles)) {
      const normalized = entryRelPath.replace(/\\/g, "/").trim();
      let newBuffer: Buffer;

      if (Buffer.isBuffer(localSource)) {
        newBuffer = localSource;
      } else {
        try {
          newBuffer = await readFile(path.resolve(localSource));
        } catch {
          throw new ToolError(`Replacement source file not found: ${localSource}`);
        }
      }

      if (fileMap.has(normalized)) {
        modifiedSet.add(normalized);
        const existing = fileMap.get(normalized)!;
        existing.buffer = newBuffer;
      } else {
        addedSet.add(normalized);
        fileMap.set(normalized, { buffer: newBuffer, unpacked: false });
      }
    }
  }

  // 3. Process text search/replace
  if (opts.replaceText) {
    for (const rule of opts.replaceText) {
      const normalized = rule.file.replace(/\\/g, "/").trim();
      const existing = fileMap.get(normalized);
      if (!existing) {
        throw new ToolError(`File not found in ASAR for text replacement: ${rule.file}`);
      }

      const text = existing.buffer.toString("utf8");
      let nextText: string;
      if (typeof rule.search === "string") {
        if (!text.includes(rule.search)) {
          throw new ToolError(`Search term not found in "${rule.file}": "${rule.search}"`);
        }
        nextText = text.replaceAll(rule.search, rule.replace);
      } else {
        if (!rule.search.test(text)) {
          throw new ToolError(`Regex pattern did not match in "${rule.file}": ${rule.search}`);
        }
        nextText = text.replace(rule.search, rule.replace);
      }

      existing.buffer = Buffer.from(nextText, "utf8");
      modifiedSet.add(normalized);
    }
  }

  // 4. Process append
  if (opts.append) {
    for (const rule of opts.append) {
      const normalized = rule.file.replace(/\\/g, "/").trim();
      const existing = fileMap.get(normalized);
      if (!existing) {
        throw new ToolError(`File not found in ASAR for append: ${rule.file}`);
      }
      existing.buffer = Buffer.concat([existing.buffer, Buffer.from(rule.content, "utf8")]);
      modifiedSet.add(normalized);
    }
  }

  // 5. Process prepend
  if (opts.prepend) {
    for (const rule of opts.prepend) {
      const normalized = rule.file.replace(/\\/g, "/").trim();
      const existing = fileMap.get(normalized);
      if (!existing) {
        throw new ToolError(`File not found in ASAR for prepend: ${rule.file}`);
      }
      existing.buffer = Buffer.concat([Buffer.from(rule.content, "utf8"), existing.buffer]);
      modifiedSet.add(normalized);
    }
  }

  // Handle backup if needed
  let backupPath: string | undefined;
  if (isInPlace && opts.backup !== false) {
    backupPath = `${resolvedAsar}.bak`;
    await copyFile(resolvedAsar, backupPath);
  }

  // Build items array
  const unpackRegex = opts.unpack ? globToRegExp(opts.unpack) : null;
  const items: AsarPayloadItem[] = [];
  const sortedKeys = Array.from(fileMap.keys()).sort();
  const outUnpackedDir = `${outPath}.unpacked`;
  let unpackedFiles = 0;
  let totalBytes = 0;

  for (const k of sortedKeys) {
    const item = fileMap.get(k)!;
    const isUnpacked = item.unpacked || (unpackRegex ? unpackRegex.test(k) || unpackRegex.test(path.basename(k)) : false);

    if (isUnpacked) {
      unpackedFiles++;
      const destUnpackedFile = path.join(outUnpackedDir, ...k.split("/"));
      await mkdir(path.dirname(destUnpackedFile), { recursive: true });
      await writeFile(destUnpackedFile, item.buffer);
      items.push({ path: k, buffer: item.buffer, unpacked: true });
    } else {
      totalBytes += item.buffer.length;
      items.push({ path: k, buffer: item.buffer, unpacked: false });
    }
  }

  const newArchiveBuf = buildAsarBuffer(items);
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, newArchiveBuf);

  return {
    asarPath: resolvedAsar,
    outPath,
    backupPath,
    modified: Array.from(modifiedSet),
    added: Array.from(addedSet),
    removed: Array.from(removedSet),
    totalFiles: items.length,
    totalBytes,
    unpackedFiles,
  };
}
