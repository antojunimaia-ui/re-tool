// Webpack bundle analysis: module graph reconstruction.
// Supports the modern format (__webpack_modules__ = { id: fn }) and the legacy
// one (!function(e){...}([fn, fn, ...])) — in both, each module's 3rd
// parameter is the require function, which gives us dependencies reliably.
import { parse } from "acorn";
import { walkTree } from "./strings.js";

export interface WebpackModule {
  /** Module key/ID (index or numeric path). */
  id: string;
  /** Original path coming from webpack path comments. */
  path?: string;
  start: number;
  end: number;
  /** Numeric IDs required via the webpack require function. */
  deps: number[];
  /** Quantidade de strings literais dentro do módulo. */
  stringCount: number;
}

export interface WebpackAnalysis {
  detected: boolean;
  style: "modern" | "legacy" | "unknown";
  modules: WebpackModule[];
  moduleCount: number;
}

function isFunctionNode(node: unknown): node is Record<string, unknown> {
  const n = node as { type?: string } | null;
  return !!n && (n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression");
}

interface CandidateObject {
  obj: { properties: any[] };
  score: number;
}

function collectModernCandidates(ast: any): CandidateObject[] {
  const out: CandidateObject[] = [];
  walkTree(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const init = node.init;
    if (!init || init.type !== "ObjectExpression") return;
    const props: any[] = init.properties ?? [];
    if (props.length < 2) return;

    let fnProps = 0;
    for (const p of props) {
      if (isFunctionNode(p.value)) fnProps++;
    }
    if (fnProps < 2) return;

    let score = fnProps;
    const name: string = node.id?.name ?? "";
    if (name === "__webpack_modules__") score += 1000;
    out.push({ obj: init, score });
  });
  return out;
}

function findLegacyModules(ast: any): { arr: { elements: any[] }; score: number } | null {
  let best: { arr: { elements: any[] }; score: number } | null = null;
  walkTree(ast, (node) => {
    // `!function(e){...}([...])` is `!(function(e){...}([...]))`:
    // the CallExpression lives inside the unary `!`.
    if (node.type !== "UnaryExpression" || node.operator !== "!") return;
    const call = node.argument;
    if (!call || call.type !== "CallExpression") return;
    if (call.callee?.type !== "FunctionExpression") return;

    for (const arg of call.arguments ?? []) {
      if (arg.type !== "ArrayExpression") continue;
      const els: any[] = arg.elements ?? [];
      const fns = els.filter((el) => isFunctionNode(el));
      if (fns.length >= 2 && (!best || fns.length > best.score)) {
        best = { arr: arg, score: fns.length };
      }
    }
  });
  return best;
}

function extractPathComment(content: string, before: number): string | undefined {
  const window = content.slice(Math.max(0, before - 600), before);
  const matches = window.match(/\/\*!\s*(.+?)\s*\*\//g);
  if (!matches || matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  const inner = last.match(/\/\*!\s*(.+?)\s*\*\//);
  return inner ? inner[1] : undefined;
}

function extractDepsFromModule(fn: any): number[] {
  const reqName: string | undefined =
    fn.params?.length >= 3 && fn.params[2]?.type === "Identifier"
      ? fn.params[2].name
      : undefined;
  const deps = new Set<number>();
  walkTree(fn, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    const name: string | undefined =
      callee?.type === "Identifier" ? callee.name : undefined;
    if (name !== reqName && name !== "__webpack_require__") return;
    const arg0 = node.arguments?.[0];
    if (arg0 && arg0.type === "Literal" && typeof arg0.value === "number") {
      deps.add(arg0.value);
    }
  });
  return [...deps];
}

function extractModuleProp(prop: any, content: string): WebpackModule | null {
  const fn = prop.value;
  if (!isFunctionNode(fn)) return null;

  const key = prop.key;
  let id = "";
  if (key?.type === "Literal") id = String(key.value);
  else if (key?.type === "Identifier") id = key.name;
  else if (key?.type === "NumericLiteral") id = String(key.value);
  else return null;

  let stringCount = 0;
  walkTree(fn, (n) => {
    if ((n.type === "Literal" && typeof n.value === "string") || n.type === "StringLiteral") {
      stringCount++;
    }
  });

  return {
    id,
    path: extractPathComment(content, prop.start),
    start: prop.start,
    end: prop.end,
    deps: extractDepsFromModule(fn),
    stringCount,
  };
}

const NO_ANALYSIS: WebpackAnalysis = {
  detected: false,
  style: "unknown",
  modules: [],
  moduleCount: 0,
};

export function analyzeWebpack(content: string): WebpackAnalysis {
  let ast: any;
  try {
    ast = parse(content, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowHashBang: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    return NO_ANALYSIS;
  }

  const modern = collectModernCandidates(ast).sort((a, b) => b.score - a.score)[0];
  const legacy = findLegacyModules(ast);

  if (modern && (!legacy || modern.score >= legacy.score)) {
    const modules: WebpackModule[] = [];
    for (const prop of modern.obj.properties) {
      const mod = extractModuleProp(prop, content);
      if (mod) modules.push(mod);
    }
    modules.sort((a, b) => Number(a.id) - Number(b.id));
    return { detected: true, style: "modern", modules, moduleCount: modules.length };
  }

  if (legacy) {
    const modules: WebpackModule[] = [];
    legacy.arr.elements.forEach((el, idx) => {
      if (!isFunctionNode(el)) return;
      const fakeProp = {
        key: { type: "Literal", value: idx },
        value: el,
        start: el.start,
        end: el.end,
      };
      const mod = extractModuleProp(fakeProp, content);
      if (mod) modules.push(mod);
    });
    return { detected: true, style: "legacy", modules, moduleCount: modules.length };
  }

  return NO_ANALYSIS;
}
