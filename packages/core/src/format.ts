// Detecção de formato de arquivos JavaScript (bundlers / minificação).
// Heurísticas por marcadores de texto — suficientes para um primeiro sniffing.

export type BundlerKind =
  | "webpack"
  | "esbuild"
  | "rollup"
  | "browserify"
  | "script";

export interface FormatInfo {
  /** Bundler/empacotador provável (ou "script" para código comum). */
  bundler: BundlerKind;
  /** Heurística: o arquivo parece minimificado (alta densidade por linha). */
  minified: boolean;
  /** Tamanho do marcador mais forte encontrado (0 = nenhum marcador). */
  markerSize: number;
}

const BUNDLER_MARKERS: ReadonlyArray<readonly [BundlerKind, RegExp]> = [
  ["webpack", /__webpack_require__|webpackJsonp|__webpack_modules__/],
  ["browserify", /^\(function e\(t,n,r\)\{function s\(o,u\)/],
  ["esbuild", /__defProp|__commonJS|__esm|__copyProps|__name/],
  ["rollup", /Object\.defineProperty\(\s*exports\s*,\s*["']__esModule["']/],
];

/** Heurística de minificação: alta densidade de código por linha. */
export function isMinified(content: string): boolean {
  const nonEmpty = content.split("\n").filter((l) => l.trim().length > 0);
  if (nonEmpty.length <= 1) return content.length > 400;
  return content.length / nonEmpty.length > 200;
}

export function detectFormat(content: string): FormatInfo {
  let best: BundlerKind = "script";
  let markerSize = 0;

  for (const [kind, re] of BUNDLER_MARKERS) {
    const m = content.match(re);
    if (m && m[0].length > markerSize) {
      markerSize = m[0].length;
      best = kind;
    }
  }

  return { bundler: best, minified: isMinified(content), markerSize };
}
