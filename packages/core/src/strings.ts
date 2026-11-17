// Extração de strings literais a partir de AST (Acorn) com fallback de scanner.
import { parse } from "acorn";

export type StringEncoding = "plain" | "hex-escaped" | "unicode-escaped" | "base64-like";

export interface ExtractedString {
  value: string;
  /** Offset de início (caracteres) no conteúdo original. */
  start: number;
  /** Offset de fim (exclusivo). */
  end: number;
  line: number;
  column: number;
  kind: "string" | "template";
  encoding: StringEncoding;
  /** Função que contém a string (quando detectável). */
  inFunction?: string;
  length: number;
  /** Entropia de Shannon (bits por caractere) do valor decodificado. */
  entropy: number;
  /** Trecho do código-fonte antes da string (até 32 caracteres). */
  ctxBefore?: string;
  /** Trecho do código-fonte depois da string (até 32 caracteres). */
  ctxAfter?: string;
}

export interface ExtractStringsOptions {
  /** Usa um scanner simplificado caso o parser falhe. Padrão: true. */
  fallback?: boolean;
}

export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / text.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Índice de linhas / localização
// ---------------------------------------------------------------------------

function buildLineIndex(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function locate(lineStarts: number[], pos: number): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: pos - lineStarts[lo] + 1 };
}

// ---------------------------------------------------------------------------
// Codificação suspeita
// ---------------------------------------------------------------------------

function detectEncoding(raw: string, value: string): StringEncoding {
  if (/\\x[0-9a-fA-F]{2}/.test(raw)) return "hex-escaped";
  if (/\\u[0-9a-fA-F]{4}/.test(raw)) return "unicode-escaped";
  if (
    value.length >= 16 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return "base64-like";
  }
  return "plain";
}

// ---------------------------------------------------------------------------
// Caminhada genérica sobre ESTree
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WalkerCb = (node: any, path: any[]) => void;

export function walkTree(node: unknown, cb: WalkerCb, path: any[] = []): void {
  if (!node || typeof node !== "object") return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = node as any;
  cb(n, path);
  for (const key of Object.keys(n)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end") continue;
    const child = n[key];
    if (Array.isArray(child)) {
      for (const item of child) walkTree(item, cb, [...path, n]);
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walkTree(child, cb, [...path, n]);
    }
  }
}

function enclosingFunctionName(path: any[]): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i];
    const t: string = node?.type ?? "";
    if (t === "FunctionDeclaration" || t === "FunctionExpression" || t === "ArrowFunctionExpression") {
      if (node.id?.name) return node.id.name;
      // Função anônima atribuída a uma variável: usa o nome da variável.
      const parent = path[i + 1];
      if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") {
        return parent.id.name;
      }
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsing (Acorn)
// ---------------------------------------------------------------------------

function parseJavaScript(content: string): { ast?: any; error?: string } {
  try {
    const ast = parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
    return { ast };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Retorna o erro de parsing (se houver) sem lançar exceção. */
export function parseErrorOf(content: string): string | undefined {
  return parseJavaScript(content).error;
}

function collectFromAst(content: string, ast: any): ExtractedString[] {
  const lineStarts = buildLineIndex(content);
  const out: ExtractedString[] = [];

  walkTree(ast, (node, path) => {
    let value: string | undefined;
    let kind: "string" | "template" = "string";

    if (node.type === "Literal" && typeof node.value === "string") {
      value = node.value;
    } else if (node.type === "StringLiteral") {
      value = node.value;
    } else if (node.type === "TemplateLiteral") {
      value = node.quasis.map((q: any) => q.value.cooked ?? q.value.raw).join("");
      kind = "template";
    }

    if (value === undefined || node.start === undefined) return;

    const raw = content.slice(node.start, node.end);
    const { line, column } = locate(lineStarts, node.start);
    const inFunction = enclosingFunctionName(path);
    const ctxBefore = content.slice(Math.max(0, node.start - 32), node.start);
    const ctxAfter = content.slice(node.end, Math.min(content.length, node.end + 32));

    out.push({
      value,
      start: node.start,
      end: node.end,
      line,
      column,
      kind,
      encoding: detectEncoding(raw, value),
      inFunction,
      length: value.length,
      entropy: shannonEntropy(value),
      ctxBefore,
      ctxAfter,
    });
  });

  return out;
}

// ---------------------------------------------------------------------------
// Fallback: scanner simplificado (quando o parser não consegue)
// ---------------------------------------------------------------------------

function decodeSimpleEscapes(text: string): string {
  const simple = new Map<string, string>([
    ["n", "\n"],
    ["t", "\t"],
    ["r", "\r"],
    ["b", "\b"],
    ["f", "\f"],
    ["v", "\v"],
    ["0", "\0"],
    ["'", "'"],
    ['"', '"'],
    ["\\", "\\"],
    ["`", "`"],
  ]);

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) {
      out += c;
      break;
    }
    if (simple.has(next)) {
      out += simple.get(next);
      i++;
      continue;
    }
    if (next === "x") {
      const hex = text.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
    }
    out += c + next;
    i++;
  }
  return out;
}

function scanStringsFallback(content: string): ExtractedString[] {
  const lineStarts = buildLineIndex(content);
  const out: ExtractedString[] = [];
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    if (ch !== '"' && ch !== "'" && ch !== "`") {
      i++;
      continue;
    }

    const quote = ch;
    let j = i + 1;
    let buf = "";
    while (j < content.length) {
      const c = content[j];
      if (c === "\\") {
        buf += c + (content[j + 1] ?? "");
        j += 2;
        continue;
      }
      if (c === quote) break;
      buf += c;
      j++;
    }

    const end = j < content.length ? j + 1 : j;
    const value = decodeSimpleEscapes(buf);
    const raw = content.slice(i, end);
    const { line, column } = locate(lineStarts, i);
    const ctxBefore = content.slice(Math.max(0, i - 32), i);
    const ctxAfter = content.slice(end, Math.min(content.length, end + 32));

    out.push({
      value,
      start: i,
      end,
      line,
      column,
      kind: quote === "`" ? "template" : "string",
      encoding: detectEncoding(raw, value),
      length: value.length,
      entropy: shannonEntropy(value),
      ctxBefore,
      ctxAfter,
    });

    i = Math.max(end, i + 1);
  }

  return out;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

export function extractStrings(content: string, opts: ExtractStringsOptions = {}): ExtractedString[] {
  const { ast } = parseJavaScript(content);
  if (ast) return collectFromAst(content, ast);
  if (opts.fallback === false) return [];
  return scanStringsFallback(content);
}
