// Relatório de análise (scan): combina detecção de formato, strings, webpack,
// source maps, obfuscators e sumário.
import { detectFormat, type FormatInfo } from "./format.js";
import { extractStrings, parseErrorOf, type ExtractedString } from "./strings.js";
import { analyzeWebpack, type WebpackAnalysis } from "./webpack.js";
import { recoverSourceMap, type SourceMapInfo } from "./sourcemap.js";
import { detectObfuscators, type ObfuscatorFinding } from "./obfuscators.js";
import type { FileSource } from "./index.js";

export interface ScanOptions {
  /** Strings mais curtas que isso são ignoradas. Padrão: 4. */
  minLength?: number;
  /** Máximo de strings incluídas no relatório. Padrão: 750. */
  limit?: number;
  /** Limiar de entropia (bits/caractere) para classificar como suspeita. Padrão: 4.5. */
  highEntropyThreshold?: number;
}

export interface ScanSummary {
  bytes: number;
  lines: number;
  totalStrings: number;
  reportedStrings: number;
  totalStringChars: number;
  averageStringLength: number;
  highEntropyCount: number;
  hexEscapedCount: number;
  unicodeEscapedCount: number;
  base64LikeCount: number;
  webpackModules: number;
  sourceMap: "inline" | "file" | null;
  obfuscators: number;
}

export interface ScanReport {
  schema: "re-tool/report@2";
  target: string;
  /** Preenchido quando o parser principal falhou (strings vieram do fallback). */
  parseError?: string;
  format: FormatInfo;
  webpack: WebpackAnalysis;
  sourceMap: SourceMapInfo;
  obfuscators: ObfuscatorFinding[];
  summary: ScanSummary;
  strings: ExtractedString[];
}

export async function scanSource(
  source: FileSource,
  opts: ScanOptions = {},
): Promise<ScanReport> {
  const minLength = opts.minLength ?? 4;
  const limit = opts.limit ?? 750;
  const threshold = opts.highEntropyThreshold ?? 4.5;

  const format = detectFormat(source.content);
  const parseError = parseErrorOf(source.content);
  const all = extractStrings(source.content);
  const filtered = all.filter((s) => s.length >= minLength);
  const reported = filtered.slice(0, limit);

  const webpack = analyzeWebpack(source.content);
  const sourceMap = await recoverSourceMap(source.content, source.path);
  const obfuscators = detectObfuscators(source.content);

  const totalStringChars = filtered.reduce((acc, s) => acc + s.length, 0);
  const highEntropyCount = filtered.filter(
    (s) => s.length >= 16 && s.entropy >= threshold,
  ).length;

  const summary: ScanSummary = {
    bytes: Buffer.byteLength(source.content, "utf8"),
    lines: source.lines.length,
    totalStrings: filtered.length,
    reportedStrings: reported.length,
    totalStringChars,
    averageStringLength:
      filtered.length > 0 ? Number((totalStringChars / filtered.length).toFixed(2)) : 0,
    highEntropyCount,
    hexEscapedCount: filtered.filter((s) => s.encoding === "hex-escaped").length,
    unicodeEscapedCount: filtered.filter((s) => s.encoding === "unicode-escaped").length,
    base64LikeCount: filtered.filter((s) => s.encoding === "base64-like").length,
    webpackModules: webpack.moduleCount,
    sourceMap: sourceMap.present ? sourceMap.kind ?? "file" : null,
    obfuscators: obfuscators.length,
  };

  const report: ScanReport = {
    schema: "re-tool/report@2",
    target: source.path,
    format,
    webpack,
    sourceMap,
    obfuscators,
    summary,
    strings: reported,
  };

  if (parseError) report.parseError = parseError;
  return report;
}
