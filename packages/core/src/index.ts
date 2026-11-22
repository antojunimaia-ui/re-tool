import { readFile } from "node:fs/promises";
import { ToolError } from "./errors.js";

// ---------------------------------------------------------------------------
// Leitura de arquivos
// ---------------------------------------------------------------------------

export interface ReadOptions {
  /**
   * Normaliza CRLF/CR para LF. Padrão: true.
   * Mantém números de linha consistentes independentemente do SO.
   */
  normalizeEol?: boolean;
}

export interface FileSource {
  path: string;
  content: string;
  /** Linhas do conteúdo (após normalização). */
  lines: string[];
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Lê um arquivo como texto UTF-8 e prepara a estrutura FileSource. */
export async function readSource(
  filePath: string,
  opts: ReadOptions = {},
): Promise<FileSource> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new ToolError(`File not found: ${filePath}`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ToolError(`Could not read file ${filePath}: ${detail}`);
  }

  const content = opts.normalizeEol === false ? raw : normalizeEol(raw);
  return { path: filePath, content, lines: content.split("\n") };
}

// ---------------------------------------------------------------------------
// Busca (search)
// ---------------------------------------------------------------------------

export interface SearchMatch {
  /** Índice (em caracteres) onde o match começa no conteúdo. */
  index: number;
  /** Tamanho do match em caracteres. */
  length: number;
  /** Linha 1-based do match. */
  line: number;
  /** Coluna 1-based do match dentro da linha. */
  column: number;
  /** Texto imediatamente antes do match (até `context` caracteres). */
  contextBefore: string;
  /** Texto exato do match. */
  match: string;
  /** Texto imediatamente depois do match (até `context` caracteres). */
  contextAfter: string;
}

export interface SearchOptions {
  /** Context characters before/after each match. Default: 400. */
  context?: number;
  /** Max matches returned. Default: 5. */
  limit?: number;
  /** Treats `term` as a regular expression. Default: false. */
  regex?: boolean;
  /** Case-insensitive search. Default: false. */
  ignoreCase?: boolean;
}

export interface SearchResult {
  file: string;
  term: string;
  regex: boolean;
  ignoreCase: boolean;
  /** Total occurrences found (may exceed `matches.length`). */
  totalMatches: number;
  /** Number of matches included in the response. */
  shown: number;
  /** true when there are more occurrences than those shown. */
  truncated: boolean;
  matches: SearchMatch[];
}

function lineAndColumnOf(content: string, index: number): { line: number; column: number } {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++;
  }
  const lineStart = content.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  return { line, column: index - lineStart + 1 };
}

function makeMatch(content: string, index: number, length: number, context: number): SearchMatch {
  const start = Math.max(0, index - context);
  const end = Math.min(content.length, index + length + context);
  const { line, column } = lineAndColumnOf(content, index);
  return {
    index,
    length,
    line,
    column,
    contextBefore: content.slice(start, index),
    match: content.slice(index, index + length),
    contextAfter: content.slice(index + length, end),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Searches occurrences of a term (literal or regex) in a file's content. */
export function findMatches(source: FileSource, term: string, opts: SearchOptions = {}): SearchResult {
  const context = opts.context ?? 400;
  const limit = opts.limit ?? 5;
  const regex = opts.regex ?? false;
  const ignoreCase = opts.ignoreCase ?? false;
  const { content } = source;

  let matcher: RegExp | undefined;

  if (regex) {
    let flags = "g";
    if (ignoreCase && !flags.includes("i")) flags += "i";
    try {
      matcher = new RegExp(term, flags);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ToolError(`Invalid regular expression: ${term} (${detail})`);
    }
  } else {
    if (term === "") {
      throw new ToolError("Search term cannot be empty.");
    }
    if (ignoreCase) {
      // Escape the literal so positions stay exact with the case-insensitive flag.
      matcher = new RegExp(escapeRegExp(term), "gi");
    }
  }

  const matches: SearchMatch[] = [];
  let total = 0;

  if (matcher) {
    let m: RegExpExecArray | null;
    while ((m = matcher.exec(content)) !== null) {
      const idx = m.index;
      const len = m[0].length;
      total++;
      if (matches.length < limit) {
        matches.push(makeMatch(content, idx, len, context));
      }
      // Avoid infinite loop with zero-length matches.
      if (len === 0) matcher.lastIndex++;
    }
  } else {
    let idx = 0;
    while ((idx = content.indexOf(term, idx)) !== -1) {
      total++;
      if (matches.length < limit) {
        matches.push(makeMatch(content, idx, term.length, context));
      }
      idx += term.length;
    }
  }

  return {
    file: source.path,
    term,
    regex,
    ignoreCase,
    totalMatches: total,
    shown: matches.length,
    truncated: total > matches.length,
    matches,
  };
}

// ---------------------------------------------------------------------------
// Extract (capture groups)
// ---------------------------------------------------------------------------

export interface ExtractOptions {
  /** Removes duplicates from the output. Default: false. */
  unique?: boolean;
  /** Max captures returned. Default: 1000. */
  limit?: number;
}

export interface ExtractResult {
  pattern: string;
  /** Total occurrences matched (including duplicates). */
  total: number;
  captures: string[];
  truncated: boolean;
}

/**
 * Extracts regex capture groups (group 1 when present, otherwise the full
 * match). With `unique`, only the first occurrence of each distinct capture is
 * kept.
 */
export function extractCaptures(
  source: FileSource,
  pattern: string,
  opts: ExtractOptions = {},
): ExtractResult {
  const unique = opts.unique ?? false;
  const limit = opts.limit ?? 1000;

  let re: RegExp;
  try {
    re = new RegExp(pattern, "g");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ToolError(`Invalid regular expression: ${pattern} (${detail})`);
  }

  const seen = new Set<string>();
  const captures: string[] = [];
  let total = 0;
  let truncated = false;
  let m: RegExpExecArray | null;

  while ((m = re.exec(source.content)) !== null) {
    total++;
    const cap = m[1] !== undefined ? m[1] : m[0];
    const dup = seen.has(cap);
    seen.add(cap);
    if (unique && dup) continue;
    if (captures.length >= limit) {
      truncated = true;
      break;
    }
    captures.push(cap);
    if (m[0].length === 0) re.lastIndex++;
  }

  return { pattern, total, captures, truncated };
}

// ---------------------------------------------------------------------------
// Posição (pos)
// ---------------------------------------------------------------------------

export interface PositionOptions {
  /** Caracteres de contexto depois do offset. Padrão: 400. */
  context?: number;
  /** Caracteres antes do offset incluídos na janela. Padrão: 100. */
  before?: number;
}

export interface PositionResult {
  file: string;
  /** Offset solicitado (índice de caractere). */
  offset: number;
  /** Índice onde a janela começa. */
  start: number;
  /** Índice (exclusivo) onde a janela termina. */
  end: number;
  /** Janela de texto exibida. */
  slice: string;
}

/** Retorna uma janela de conteúdo ao redor de um offset de caractere. */
export function windowAt(source: FileSource, offset: number, opts: PositionOptions = {}): PositionResult {
  const context = opts.context ?? 400;
  const before = opts.before ?? 100;
  const start = Math.max(0, offset - before);
  const end = Math.min(source.content.length, offset + context);
  return {
    file: source.path,
    offset,
    start,
    end,
    slice: source.content.slice(start, end),
  };
}

// ---------------------------------------------------------------------------
// Linha (line)
// ---------------------------------------------------------------------------

export interface LineResult {
  file: string;
  lineNumber: number;
  content: string;
  /** true quando a linha foi truncada para `maxLength`. */
  truncated: boolean;
}

/** Retorna o conteúdo de uma linha específica (1-based), com truncamento opcional. */
export function readLine(source: FileSource, lineNumber: number, maxLength = 400): LineResult {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new ToolError("Line number must be an integer >= 1.");
  }
  const raw = source.lines[lineNumber - 1];
  if (raw === undefined) {
    throw new ToolError(
      `File has ${source.lines.length} line(s); line ${lineNumber} does not exist.`,
    );
  }
  const truncated = raw.length > maxLength;
  return {
    file: source.path,
    lineNumber,
    content: truncated ? raw.slice(0, maxLength) : raw,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Módulos de análise (M1): formato, strings, beautify e relatório
// ---------------------------------------------------------------------------

export * from "./errors.js";
export * from "./format.js";
export * from "./strings.js";
export * from "./beautify.js";
export * from "./report.js";
export * from "./webpack.js";
export * from "./sourcemap.js";
export * from "./obfuscators.js";
export * from "./asar.js";
export * from "./web.js";
export * from "./browser.js";
export * from "./unpack.js";
export * from "./audit.js";
export * from "./patch.js";
export * from "./decode.js";
