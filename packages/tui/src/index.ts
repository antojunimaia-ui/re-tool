// Interactive TUI for re-tool reports.
//
// Look & feel: 24-bit palette, bordered panels, per-section themes, shortcut
// chips and a scroll bar. Requires a (TTY) terminal that supports
// ANSI/truecolor sequences (Windows Terminal, kitty, iTerm2, VS Code, etc.).
import {
  maskSecret,
  type ScanReport,
  type ElectronReport,
  type AsarFileAnalysis,
  type WebReport,
} from "re-tool-core";

export interface Section {
  title: string;
  lines: string[];
}

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------

type RGB = readonly [number, number, number];

const C = {
  text: [199, 210, 232] as RGB,
  dim: [107, 122, 153] as RGB,
  faint: [66, 78, 105] as RGB,

  panel: [22, 29, 46] as RGB,
  panelAlt: [17, 23, 38] as RGB,
  border: [51, 65, 105] as RGB,
  borderSoft: [37, 47, 77] as RGB,

  accent: [56, 189, 248] as RGB, // ciano
  accentBg: [8, 47, 73] as RGB,
  selBg: [30, 58, 138] as RGB, // azul
  selFg: [224, 242, 254] as RGB,

  good: [52, 211, 153] as RGB,
  warn: [251, 191, 36] as RGB,
  danger: [248, 113, 113] as RGB,
  info: [96, 165, 250] as RGB,
  purple: [167, 139, 250] as RGB,
} as const;

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

function fg(rgb: RGB, s: string): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}`;
}

function fgBold(rgb: RGB, s: string): string {
  return `${BOLD}\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}${RESET}`;
}

function paintBg(bg: RGB, fgc: RGB, s: string): string {
  return `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m\x1b[38;2;${fgc[0]};${fgc[1]};${fgc[2]}m${s}${RESET}`;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visLen(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function padVis(s: string, w: number): string {
  const v = visLen(s);
  return v >= w ? s : s + " ".repeat(w - v);
}

/** Trims to `w` visible characters, preserving complete ANSI sequences. */
function clipVis(s: string, w: number): string {
  if (w <= 0) return "";
  let out = "";
  let vis = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\x1b") {
      const end = s.indexOf("m", i);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end;
      continue;
    }
    if (vis >= w) break;
    out += ch;
    vis++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section construction from a report
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function summaryLines(summary: ScanReport["summary"]): string[] {
  return [
    `bytes ${summary.bytes} · lines ${summary.lines} · strings ${summary.totalStrings} (reported ${summary.reportedStrings})`,
    `chars ${summary.totalStringChars} · avg ${summary.averageStringLength} · high-entropy ${summary.highEntropyCount}`,
    `hex ${summary.hexEscapedCount} · unicode ${summary.unicodeEscapedCount} · base64 ${summary.base64LikeCount}`,
    `webpack modules ${summary.webpackModules} · sourceMap ${summary.sourceMap ?? "—"} · obfuscators ${summary.obfuscators}`,
  ];
}

function formatLines(format: ScanReport["format"]): string[] {
  return [
    `bundler: ${format.bundler}`,
    `minified: ${format.minified}`,
    `marker: ${format.markerSize}`,
  ];
}

function webpackLines(wp: ScanReport["webpack"]): string[] {
  if (!wp.detected) return ["— webpack not detected"];
  const out = [`style: ${wp.style} · modules: ${wp.moduleCount}`];
  for (const m of wp.modules) {
    const deps = m.deps.length ? ` deps [${m.deps.join(",")}]` : "";
    const p = m.path ? `  ${m.path}` : "";
    out.push(`#${m.id}${p}${deps}  strings=${m.stringCount}`);
  }
  return out;
}

function sourceMapLines(sm: ScanReport["sourceMap"]): string[] {
  if (!sm.present) return ["— no source map"];
  const out: string[] = [];
  out.push(`type: ${sm.kind}  uri: ${sm.uri}`);
  if (sm.error) out.push(`error: ${sm.error}`);
  if (typeof sm.version === "number") out.push(`version: ${sm.version}`);
  if (sm.file) out.push(`file: ${sm.file}`);
  if (sm.sources && sm.sources.length) {
    out.push(`sources (${sm.sources.length}):`);
    for (const s of sm.sources) out.push(`  ${s}`);
  }
  if (sm.names && sm.names.length) out.push(`names: ${sm.names.length}`);
  out.push(
    `sourcesContent: ${sm.hasSourcesContent ? `yes (${sm.sourcesContentCount})` : "no"}`,
  );
  return out;
}

function obfuscatorLines(list: ScanReport["obfuscators"]): string[] {
  if (!list.length) return ["— no obfuscation detected"];
  const out: string[] = [];
  for (const f of list) {
    out.push(`${f.name}  (confidence ${f.confidence})`);
    for (const s of f.signals ?? []) out.push(`  • ${s}`);
  }
  return out;
}

function stringLine(s: ScanReport["strings"][number]): string {
  const where = `[${s.line}:${s.column}]`;
  const fn = s.inFunction ? ` in ${s.inFunction}` : "";
  return `${JSON.stringify(s.value)}  ${where} ${s.encoding} len=${s.length} ent=${s.entropy.toFixed(2)}${fn}`;
}

function fileLines(f: AsarFileAnalysis): string[] {
  const out: string[] = [];
  out.push(`size: ${f.size}B`);
  out.push(`bundler: ${f.format.bundler} · minified: ${f.format.minified}`);
  if (f.parseError) out.push(`parseError: ${f.parseError}`);
  out.push(`webpack modules: ${f.webpackModules}`);
  for (const o of f.obfuscators ?? []) {
    out.push(`obfuscation: ${o.name} (${o.confidence})`);
  }
  if (f.sourceMap.present) {
    out.push(`sourceMap: ${f.sourceMap.kind} · sources ${f.sourceMap.sources?.length ?? 0}`);
  }
  if (f.strings.length) {
    out.push(`strings (${f.stringTotal}):`);
    for (const s of f.strings) out.push(`  ${stringLine(s)}`);
  }
  return out;
}

export interface TuiStringItem {
  file: string;
  value: string;
  line: number;
  column: number;
  start: number;
  end: number;
  encoding: string;
  length: number;
  entropy: number;
  inFunction?: string;
  ctxBefore?: string;
  ctxAfter?: string;
}

/** Extracts structured strings (with location + snippet) from a report. */
export function getStringsForTui(
  report: Record<string, unknown>,
): { target: string; strings: TuiStringItem[] } | null {
  const toItem = (file: string, s: ScanReport["strings"][number]): TuiStringItem => ({
    file,
    value: s.value,
    line: s.line,
    column: s.column,
    start: s.start,
    end: s.end,
    encoding: s.encoding,
    length: s.length,
    entropy: s.entropy,
    inFunction: s.inFunction,
    ctxBefore: s.ctxBefore,
    ctxAfter: s.ctxAfter,
  });

  if (str(report.schema) === "re-tool/electron-report@1") {
    const r = report as unknown as ElectronReport;
    const strings: TuiStringItem[] = [];
    for (const f of r.files) {
      for (const s of f.strings) strings.push(toItem(f.path, s));
    }
    return { target: str(r.target), strings };
  }

  if (str(report.schema) === "re-tool/web-report@1") {
    const r = report as unknown as WebReport;
    const strings: TuiStringItem[] = [];
    for (const f of r.files) {
      for (const s of f.strings) strings.push(toItem(f.path, s));
    }
    return { target: str(r.target), strings };
  }

  const r = report as unknown as ScanReport;
  if (!Array.isArray(r.strings)) return null;
  return { target: str(r.target), strings: r.strings.map((s) => toItem(str(r.target), s)) };
}

/** Converts a report (report@2 or electron-report@1) into sections. */
export function buildSections(report: Record<string, unknown>): Section[] {
  if (str(report.schema) === "re-tool/electron-report@1") {
    const r = report as unknown as ElectronReport;
    const sections: Section[] = [
      {
        title: "Summary",
        lines: [
          `files ${r.asar.totalFiles} · bytes ${r.asar.totalBytes} · JS analyzed ${r.asar.jsFilesAnalyzed} · skipped ${r.asar.skipped}`,
          `strings ${r.summary.totalStrings} · base64 ${r.summary.base64Like} · hex ${r.summary.hexEscaped} · high-entropy ${r.summary.highEntropy}`,
          `files with obfuscation ${r.summary.obfuscatorFiles} · webpack ${r.summary.webpackFiles}`,
        ],
      },
    ];
    for (const f of r.files) {
      sections.push({ title: `${f.path} (${f.stringTotal})`, lines: fileLines(f) });
    }
    return sections;
  }

  if (str(report.schema) === "re-tool/web-report@1") {
    const r = report as unknown as WebReport;
    const sections: Section[] = [
      {
        title: "Summary",
        lines: [
          `url ${r.target}`,
          `status ${r.page.status} · ${r.page.contentType ?? "?"} · ${r.page.bytes} bytes · ${r.summary.elapsedMs} ms`,
          `assets ${r.summary.assets} · scripts ${r.summary.scripts} · analyzed ${r.summary.scriptsAnalyzed} · jsBytes ${r.summary.jsBytes} · errors ${r.summary.fetchErrors} · skipped ${r.summary.skippedAssets ?? 0}`,
          `strings ${r.summary.totalStrings} · frameworks ${r.summary.frameworks} · endpoints ${r.summary.endpoints} · routes ${r.summary.routes} · keys ${r.summary.keys} · flags ${r.summary.featureFlags}`,
        ],
      },
      {
        title: "Page",
        lines: [
          `title: ${r.page.title ?? "—"}`,
          `description: ${r.page.description ?? "—"}`,
          `generator: ${r.page.generator ?? "—"}`,
          `base: ${r.page.baseUrl}`,
          `robots: ${r.page.robots.checked ? (r.page.robots.allowed ? "allowed" : "blocked") : "not checked"}${r.page.robots.rule ? ` (${r.page.robots.rule})` : ""}`,
          ...r.page.redirects.map((x) => `redirect: ${x.from} → ${x.to}`),
        ],
      },
      {
        title: `Frameworks (${r.frameworks.length})`,
        lines: r.frameworks.map(
          (f) =>
            `${f.name}${f.version ? ` ${f.version}` : ""}  [${f.category}] ${f.confidence} — ${f.evidence.join(", ")}`,
        ),
      },
      {
        title: `Endpoints (${r.endpoints.length})`,
        lines: r.endpoints.map((e) => `${e.value}  (${e.kind} x${e.count})  ${e.source}:${e.line}`),
      },
      {
        title: `Routes (${r.routes.length})`,
        lines: r.routes.map((x) => `${x.path}  x${x.count}  ${x.source}:${x.line}`),
      },
      {
        title: `Keys (${r.keys.length})`,
        lines: r.keys.map((k) => `${k.kind}  ${maskSecret(k.value)}  ${k.source}:${k.line}`),
      },
      {
        title: `Flags (${r.featureFlags.length})`,
        lines: r.featureFlags.map((f) => `${f.name}  ${f.source}:${f.line}`),
      },
      {
        title: `Assets (${r.assets.length})`,
        lines: r.assets.map(
          (a) =>
            `${a.type}  ${a.path}  ${a.bytes}B  ${a.status ?? "—"}${a.analyzed ? "  analyzed" : ""}${a.error ? `  (${a.error})` : ""}`,
        ),
      },
    ];
    for (const f of r.files) {
      sections.push({ title: `${f.path} (${f.stringTotal})`, lines: fileLines(f) });
    }
    return sections;
  }

  const r = report as unknown as ScanReport;
  const sections: Section[] = [
    { title: "Summary", lines: summaryLines(r.summary) },
    { title: "Format", lines: formatLines(r.format) },
  ];
  if (r.parseError) {
    sections[0].lines.push(`parseError: ${r.parseError}`);
  }
  sections.push({ title: "Webpack", lines: webpackLines(r.webpack) });
  sections.push({ title: "SourceMap", lines: sourceMapLines(r.sourceMap) });
  sections.push({ title: "Obfuscators", lines: obfuscatorLines(r.obfuscators) });
  sections.push({
    title: `Strings (${r.summary.reportedStrings})`,
    lines: r.strings.map(stringLine),
  });
  return sections;
}

// ---------------------------------------------------------------------------
// Section themes
// ---------------------------------------------------------------------------

function sectionTheme(title: string): RGB {
  if (title === "Summary") return C.info;
  if (title === "Format") return C.text;
  if (title === "Webpack") return C.purple;
  if (title === "SourceMap") return C.accent;
  if (title === "Obfuscators") return C.danger;
  if (title === "Page") return C.info;
  if (title.startsWith("Frameworks")) return C.purple;
  if (title.startsWith("Endpoints")) return C.accent;
  if (title.startsWith("Routes")) return C.warn;
  if (title.startsWith("Keys")) return C.danger;
  if (title.startsWith("Flags")) return C.good;
  if (title.startsWith("Assets")) return C.dim;
  if (title.startsWith("Strings")) return C.good;
  return C.text; // files in the electron/web report
}

function panelTitleColor(title: string): RGB {
  return sectionTheme(title);
}

function colCount(s: Section): number {
  const m = s.title.match(/\((\d+)\)\s*$/);
  return m ? Number(m[1]) : 0;
}

function splitVis(s: string, w: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
  return out;
}

function chip(key: string, label: string): string {
  return fgBold(C.accent, `[${key}]`) + " " + fg(C.dim, label);
}

// ---------------------------------------------------------------------------
// Frame composition
// ---------------------------------------------------------------------------

interface FrameCtx {
  report: Record<string, unknown>;
  sections: Section[];
  sel: number;
  scroll: number;
  leftStart: number;
  filter: string;
  filterActive: boolean;
  cols: number;
  rows: number;
  withEnterAlt: boolean;
}

function renderRightRow(
  window: string[],
  i: number,
  width: number,
  color: RGB,
  total: number,
  height: number,
  sc: number,
): string {
  const raw = i < window.length ? window[i] : "";
  const chunks = splitVis(raw, width);
  const first = chunks[0] ?? "";
  let row = fg(C.border, "│") + fg(color, padVis(first, width));

  let bar = " ";
  if (total > height) {
    const filled = Math.max(1, Math.round((height / total) * height));
    const maxOff = height - filled;
    const off = Math.round((sc / (total - height)) * maxOff);
    if (i >= off && i < off + filled) bar = "▐";
  }
  row += fg(C.border, "│") + (bar === "▐" ? fg(C.accent, bar) : fg(C.faint, bar));
  return row;
}

function composeFrame(ctx: FrameCtx): string {
  const { report, sections, cols, rows } = ctx;
  let { sel, scroll, leftStart } = ctx;
  const { filter, filterActive } = ctx;

  if (sel >= sections.length) sel = Math.max(0, sections.length - 1);
  const sec = sections[sel];

  const sb: string[] = [];
  if (ctx.withEnterAlt) sb.push("\x1b[?1049h");
  sb.push("\x1b[H\x1b[2J");

  // ---- Header ----
  const headParts: string[] = [];
  headParts.push(fgBold(C.accent, "● "));
  headParts.push(fgBold(C.text, "re-tool"));
  headParts.push("  ");
  headParts.push(paintBg(C.accentBg, C.accent, ` ${str(report.schema)} `));
  const target = str((report as { target?: unknown }).target ?? "");
  if (target) headParts.push("  " + fg(C.dim, target));

  const chips: string[] = [];
  if (str(report.schema) === "re-tool/electron-report@1") {
    const r = report as unknown as ElectronReport;
    chips.push(`${r.asar.totalFiles} files`);
    chips.push(`${r.summary.totalStrings} strings`);
    if (r.summary.webpackFiles > 0) chips.push(`${r.summary.webpackFiles} webpack`);
    if (r.summary.obfuscatorFiles > 0) chips.push(`${r.summary.obfuscatorFiles} obfuscated`);
  } else if (str(report.schema) === "re-tool/web-report@1") {
    const r = report as unknown as WebReport;
    chips.push(`${r.assets.length} assets`);
    chips.push(`${r.endpoints.length} endpoints`);
    if (r.routes.length > 0) chips.push(`${r.routes.length} routes`);
    if (r.keys.length > 0) chips.push(`${r.keys.length} keys`);
    if (r.frameworks.length > 0) chips.push(`${r.frameworks.length} frameworks`);
  } else {
    const r = report as unknown as ScanReport;
    chips.push(`${r.summary.totalStrings} strings`);
    if (r.summary.webpackModules > 0) chips.push(`${r.summary.webpackModules} modules`);
    if (r.summary.obfuscators > 0) chips.push(`${r.summary.obfuscators} obfuscators`);
    if (r.sourceMap.present) chips.push(`sourceMap ${r.sourceMap.kind}`);
  }
  const chipsStr = chips.map((c) => paintBg(C.panelAlt, C.dim, ` ${c} `)).join(" ");
  const headLine = clipVis(
    padVis(headParts.join(""), Math.max(0, cols - visLen(chipsStr) - 2)) + " " + chipsStr,
    cols,
  );
  sb.push(fg(C.text, headLine) + "\n");
  sb.push(fg(C.borderSoft, "─".repeat(cols)) + "\n");

  // ---- Corpo ----
  const bodyRows = Math.max(4, rows - 5);
  const leftW = Math.min(34, Math.max(24, Math.floor(cols * 0.34)));
  const gap = 2;
  const rightW = Math.max(24, cols - leftW - gap);
  const leftInW = leftW - 2;
  const rightInW = rightW - 3;

  const listH = bodyRows - 2;
  if (sel < leftStart) leftStart = sel;
  if (sel >= leftStart + listH) leftStart = sel - listH + 1;
  if (leftStart > Math.max(0, sections.length - listH)) {
    leftStart = Math.max(0, sections.length - listH);
  }

  sb.push(
    fg(C.border, "┌─ Sections ─") +
      fg(C.border, "─".repeat(Math.max(0, leftInW - 9))) +
      fg(C.border, "┐") +
      " ".repeat(gap),
  );
  const rightTitle = sec ? sec.title : "";
  sb.push(
    fg(C.border, "┌─") +
      " " +
      fgBold(panelTitleColor(rightTitle), rightTitle) +
      " " +
      fg(C.border, "─".repeat(Math.max(0, rightInW + 1 - visLen(rightTitle)))) +
      fg(C.border, "┐") +
      "\n",
  );

  const rightLines = sec ? sec.lines : [];
  const maxScroll = Math.max(0, rightLines.length - listH);
  if (scroll > maxScroll) scroll = maxScroll;
  const rightWindow = rightLines.slice(scroll, scroll + listH);

  const leftRows: string[] = [];
  for (let i = 0; i < listH; i++) {
    const idx = leftStart + i;
    const s = sections[idx];
    if (!s) {
      leftRows.push(fg(C.faint, " ".repeat(leftInW)));
      continue;
    }
    const isSel = idx === sel;
    const marker = isSel ? "▸" : " ";
    const maxTitle = leftInW - 5;
    const shown =
      visLen(s.title) > maxTitle ? s.title.slice(0, maxTitle - 1) + "…" : s.title;
    const count = colCount(s);
    const countStr = count > 0 ? String(count) : "";
    const countPad = Math.max(0, leftInW - 4 - visLen(shown));
    const lineContent = `${marker} ${shown}${" ".repeat(countPad)}${countStr}`;
    leftRows.push(
      isSel
        ? paintBg(C.selBg, C.selFg, padVis(lineContent, leftInW))
        : fg(C.text, padVis(lineContent, leftInW)),
    );
  }

  const rightColor = sectionTheme(rightTitle);

  for (let i = 0; i < listH; i++) {
    const leftPart =
      fg(C.border, "│") + leftRows[i] + fg(C.border, "│") + " ".repeat(gap);
    const rightPart = renderRightRow(
      rightWindow,
      i,
      rightInW,
      rightColor,
      rightLines.length,
      listH,
      scroll,
    );
    sb.push(leftPart + rightPart + "\n");
  }

  sb.push(
    fg(C.border, "└") + fg(C.border, "─".repeat(leftInW)) + fg(C.border, "┘") + " ".repeat(gap),
  );
  sb.push(
    fg(C.border, "└") +
      fg(C.border, "─".repeat(rightInW + 1)) +
      fg(C.border, "┘") +
      "\n",
  );

  // ---- Barra de filtro ----
  sb.push("\n");
  const filterLabel = filterActive
    ? fgBold(C.accent, `search: ${filter}▌`)
    : filter
      ? fg(C.dim, `filter: ${filter} (Enter applies · Esc clears)`)
      : fg(C.faint, "press / to search");
  sb.push(paintBg(C.panelAlt, C.text, padVis(filterLabel, cols)) + "\n");

  // ---- Barra de atalhos ----
  const keys = [
    chip("↑↓", "navigate"),
    chip("PgUp/Dn", "scroll"),
    chip("/", "search"),
    chip("g/G", "top/bottom"),
    chip("r", "redraw"),
    chip("q", "quit"),
  ].join("   ");
  sb.push(fg(C.dim, clipVis(keys, cols)) + "\n");

  return sb.join("");
}

// ---------------------------------------------------------------------------
// Non-interactive preview (for capture/tests)
// ---------------------------------------------------------------------------

export interface PreviewOptions {
  cols?: number;
  rows?: number;
}

export function renderPreview(
  report: Record<string, unknown>,
  opts: PreviewOptions = {},
): string {
  return composeFrame({
    report,
    sections: buildSections(report),
    sel: 0,
    scroll: 0,
    leftStart: 0,
    filter: "",
    filterActive: false,
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 32,
    withEnterAlt: false,
  });
}

// ---------------------------------------------------------------------------
// Loop interativo
// ---------------------------------------------------------------------------

export * from "./opentui.js"; // motor OpenTUI (Anomaly) — requer Node >= 26.4 ou Bun

export async function renderInteractive(report: Record<string, unknown>): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("re-tool tui requer um terminal interativo (TTY).");
  }

  const allSections = buildSections(report);
  if (allSections.length === 0) {
    console.log("Report has no sections to display.");
    return;
  }

  let sel = 0;
  let scroll = 0;
  let leftStart = 0;
  let filter = "";
  let filterActive = false;

  const visible = (): Section[] => {
    if (!filter) return allSections;
    const q = filter.toLowerCase();
    return allSections.filter((s) =>
      (s.title + "\n" + s.lines.join("\n")).toLowerCase().includes(q),
    );
  };

  const draw = (): void => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    process.stdout.write(
      composeFrame({
        report,
        sections: visible(),
        sel,
        scroll,
        leftStart,
        filter,
        filterActive,
        cols,
        rows,
        withEnterAlt: true,
      }),
    );
  };

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<void>((resolve) => {
    let done = false;
    let onData: (chunk: string) => void = () => {};

    const cleanup = (): void => {
      if (done) return;
      done = true;
      stdin.removeListener("data", onData);
      process.removeListener("SIGINT", onSigint);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\x1b[?1049l");
      resolve();
    };

    const finish = (): void => cleanup();
    const onSigint = (): void => cleanup();

    const applySel = (delta: number): void => {
      const v = visible();
      sel = Math.min(Math.max(sel + delta, 0), Math.max(0, v.length - 1));
      scroll = 0;
    };

    const handleChar = (c: string): void => {
      if (c === "\x03") {
        finish();
        return;
      }
      if (filterActive) {
        if (c === "\r") {
          filterActive = false;
          sel = 0;
          scroll = 0;
        } else if (c === "\x7f") {
          filter = filter.slice(0, -1);
        } else if (c === "\x1b") {
          filter = "";
          filterActive = false;
        } else {
          filter += c;
        }
        sel = 0;
        scroll = 0;
        draw();
        return;
      }

      switch (c) {
        case "q":
          finish();
          return;
        case "j":
        case "\r":
          applySel(1);
          break;
        case "k":
          applySel(-1);
          break;
        case "g":
          sel = 0;
          scroll = 0;
          break;
        case "G":
          sel = visible().length - 1;
          scroll = 0;
          break;
        case "/":
          filterActive = true;
          break;
        case "r":
          break;
        default:
          break;
      }
      draw();
    };

    let buf = "";
    onData = (chunk: string): void => {
      buf += chunk;
      while (buf.length > 0) {
        if (buf[0] === "\x1b") {
          if (buf.startsWith("\x1b[A")) {
            handleChar("k");
            buf = buf.slice(3);
          } else if (buf.startsWith("\x1b[B")) {
            handleChar("j");
            buf = buf.slice(3);
          } else if (buf.startsWith("\x1b[5~")) {
            applySel(-10);
            draw();
            buf = buf.slice(4);
          } else if (buf.startsWith("\x1b[6~")) {
            applySel(10);
            draw();
            buf = buf.slice(4);
          } else if (buf[1] === "\x1b") {
            buf = buf.slice(1);
          } else {
            handleChar("\x1b");
            buf = buf.slice(1);
          }
        } else {
          const c = buf[0];
          buf = buf.slice(1);
          handleChar(c);
        }
      }
    };

    stdin.on("data", onData);
    process.on("SIGINT", onSigint);
    draw();
  });
}
