// OpenTUI-based TUI engine (Anomaly) — @opentui/core.
//
// Required runtime: Bun >= 1.3.14 or Node.js >= 26.4.0 with ESM and
// `--experimental-ffi`. The native module is loaded dynamically, so running
// on Node 24 without requesting this engine is unaffected.
import {
  buildSections,
  getStringsForTui,
  type Section,
  type TuiStringItem,
} from "./index.js";

export function assertOpenTuiRuntime(): void {
  if (
    typeof process !== "undefined" &&
    (process as unknown as { isBun?: boolean }).isBun
  ) {
    return;
  }
  const m = /^v(\d+)\.(\d+)/.exec(process.version ?? "");
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  if (major > 26 || (major === 26 && minor >= 4)) return;
  throw new Error(
    `OpenTUI requires Node.js >= 26.4.0 (or Bun). You are on ${process.version ?? "?"}.\n` +
      `Tip: use the project's portable Node:\n` +
      `  .\\tools\\node-v26.13.1-win-x64\\node.exe --experimental-ffi <re-tool command>`,
  );
}

interface OpenTuiTypes {
  TextRenderable: new (ctx: unknown, opts: { content?: string }) => any;
  BoxRenderable: new (ctx: unknown, opts?: Record<string, unknown>) => any;
  ScrollBoxRenderable: new (ctx: unknown, opts?: Record<string, unknown>) => any;
}

interface EngineDeps {
  renderer: any;
  root: any;
  Text: OpenTuiTypes["TextRenderable"];
  Box: OpenTuiTypes["BoxRenderable"];
  ScrollBox: OpenTuiTypes["ScrollBoxRenderable"];
}

export type KeyAction =
  | "up"
  | "down"
  | "pageup"
  | "pagedown"
  | "top"
  | "bottom"
  | "confirm"
  | "cancel"
  | "redraw"
  | "quit"
  | null;

/** Maps an OpenTUI KeyEvent to a TUI action (pure, testable). */
export function matchKeyAction(key: any): KeyAction {
  const name = String(key?.name ?? "").toLowerCase();
  const seq = String(key?.sequence ?? "");
  if (key?.eventType === "release") return null;
  const is = (...names: string[]): boolean =>
    names.includes(name) || names.some((n) => seq === n);

  if (is("up", "arrowup", "\x1b[A")) return "up";
  if (is("down", "arrowdown", "\x1b[B")) return "down";
  if (is("pageup", "\x1b[5~")) return "pageup";
  if (is("pagedown", "\x1b[6~")) return "pagedown";
  if (name === "g" && key?.shift) return "bottom";
  if (name === "g") return "top";
  if (is("enter", "return", "\r")) return "confirm";
  if (is("escape", "esc", "\x1b")) return "cancel";
  if (name === "r") return "redraw";
  if (is("q")) return "quit";
  return null;
}

/** Renders a report in the OpenTUI TUI. Blocks until the user quits. */
export async function renderOpenTui(report: Record<string, unknown>): Promise<void> {
  assertOpenTuiRuntime();

  const core = (await import("@opentui/core")) as {
    createCliRenderer: (config?: Record<string, unknown>) => Promise<any>;
    TextRenderable: OpenTuiTypes["TextRenderable"];
    BoxRenderable: OpenTuiTypes["BoxRenderable"];
    ScrollBoxRenderable: OpenTuiTypes["ScrollBoxRenderable"];
  };

  const renderer = await core.createCliRenderer({ exitOnCtrlC: true });
  const root = renderer.root;

  const deps: EngineDeps = {
    renderer,
    root,
    Text: core.TextRenderable,
    Box: core.BoxRenderable,
    ScrollBox: core.ScrollBoxRenderable,
  };

  const sections = buildSections(report);
  const stringsData = getStringsForTui(report) ?? { target: "", strings: [] };
  let sel = 0;
  let scroll = 0;
  let stringSel = 0;
  let detailView = false;

  const set = (target: any, key: string, value: unknown): void => {
    try {
      target[key] = value;
    } catch {
      /* optional style not supported: ignore */
    }
  };

  const safe = (key: string, value: unknown): void => set(root, key, value);
  safe("flexDirection", "column");

  // ---- Corpo (linha: esquerda | direita) ----
  const body = new deps.Box(renderer, { border: false });
  body.flexDirection = "row";

  const leftBox = new deps.Box(renderer, {
    border: true,
    title: " Sections ",
    width: 34,
    focusable: true,
  });
  const rightBox = new deps.ScrollBox(renderer, {
    border: true,
    title: " Details ",
    bottomTitle: " [↑↓] navigate · [PgUp/Dn] scroll · [g/G] top/bottom · [q] quit · OpenTUI ",
    scrollY: true,
    focusable: false,
  });
  set(rightBox, "flexGrow", 1);

  body.add(leftBox);
  body.add(rightBox);

  const leftTexts: any[] = [];
  const rightTexts: any[] = [];
  const MAX_LEFT = 200;
  const MAX_RIGHT = 1000;

  for (let i = 0; i < MAX_LEFT; i++) {
    const t = new deps.Text(renderer, { content: " " });
    set(t, "height", 1);
    leftTexts.push(t);
    leftBox.add(t);
  }
  for (let i = 0; i < MAX_RIGHT; i++) {
    const t = new deps.Text(renderer, { content: " " });
    rightTexts.push(t);
    rightBox.add(t);
  }

  const visible = (): Section[] => sections;

  const stringDetailLines = (it: TuiStringItem | undefined): string[] => {
    if (!it) return ["— select a string first"];
    const out: string[] = [];
    out.push(`value   ${JSON.stringify(it.value)}`);
    out.push(`file    ${it.file}`);
    out.push(`line    ${it.line}`);
    out.push(`column  ${it.column}`);
    out.push(`offset  ${it.start} .. ${it.end}`);
    out.push(`type    ${it.encoding}  len=${it.length}  ent=${it.entropy.toFixed(2)}`);
    if (it.inFunction) out.push(`in function ${it.inFunction}`);
    out.push("");
    out.push("code snippet:");
    out.push(`${it.ctxBefore ?? ""}⟦${it.value}⟧${it.ctxAfter ?? ""}`);
    return out;
  };

  const render = (): void => {
    const v = visible();
    if (sel >= v.length) sel = Math.max(0, v.length - 1);
    const sec = v[sel];
    const isStrings = !!sec && sec.title.startsWith("Strings");
    const strs = isStrings ? stringsData.strings : [];

    if (!isStrings) {
      stringSel = 0;
      detailView = false;
    } else if (stringSel >= strs.length) {
      stringSel = Math.max(0, strs.length - 1);
    }

    for (let i = 0; i < MAX_LEFT; i++) {
      const s = v[i];
      if (!s) {
        leftTexts[i].content = "";
        continue;
      }
      const marker = i === sel ? "▸ " : "  ";
      const badge = /\((\d+)\)\s*$/.exec(s.title);
      const suffix = badge ? `  ${badge[1]}` : "";
      leftTexts[i].content = marker + s.title.slice(0, 26) + suffix;
    }

    let lines: string[] = [];
    if (detailView && isStrings) {
      lines = stringDetailLines(strs[stringSel]);
    } else if (isStrings) {
      lines = strs.map((it) => {
        const marker = it === strs[stringSel] ? "▸ " : "  ";
        const where = `[${it.line}:${it.column}]`;
        const pretty = JSON.stringify(it.value);
        return `${marker}${pretty}${" ".repeat(Math.max(1, 30 - pretty.length))}${where}`;
      });
    } else {
      lines = sec ? sec.lines : [];
    }

    for (let i = 0; i < MAX_RIGHT; i++) {
      rightTexts[i].content = i < lines.length ? lines[i] : "";
    }
    rightBox.title = detailView
      ? " Location "
      : isStrings
        ? " Strings — Enter to locate "
        : sec
          ? ` ${sec.title} `
          : " Details ";
    rightBox.bottomTitle = isStrings
      ? detailView
        ? " [Esc] back · [↑↓] scroll · [q] quit "
        : " [↑↓] pick string · [Enter] location · [q] quit "
      : " [↑↓] navigate · [PgUp/Dn] scroll · [g/G] top/bottom · [q] quit ";
    try {
      rightBox.scrollTo(0);
    } catch {
      /* native scroll unavailable: ignore */
    }
  };

  root.add(body);

  const moveSel = (delta: number): void => {
    const v = visible();
    sel = Math.min(Math.max(sel + delta, 0), Math.max(0, v.length - 1));
    scroll = 0;
    render();
  };

  const scrollBy = (delta: number): void => {
    scroll += delta;
    try {
      rightBox.scrollBy({ y: delta });
    } catch {
      /* ignora */
    }
  };

  const destroy = (): void => {
    try {
      renderer.destroy();
    } catch {
      /* already destroyed */
    }
  };

  const seenKeys = new WeakSet<object>();
  const handleKey = (key: any): boolean => {
    if (key && typeof key === "object") {
      if (seenKeys.has(key)) return true;
      seenKeys.add(key);
    }
    const action = matchKeyAction(key);
    if (!action) return false;

    const cur = sections[Math.min(sel, Math.max(0, sections.length - 1))];
    const inStringsList = !detailView && !!cur && cur.title.startsWith("Strings");
    const strsLen = stringsData.strings.length;

    switch (action) {
      case "confirm":
        if (inStringsList && strsLen > 0) {
          detailView = true;
          scroll = 0;
          render();
        }
        break;
      case "cancel":
        if (detailView) {
          detailView = false;
          scroll = 0;
          render();
        }
        break;
      case "up":
        if (detailView) {
          scrollBy(-1);
        } else if (inStringsList) {
          if (stringSel > 0) {
            stringSel--;
            render();
          } else {
            moveSel(-1);
          }
        } else {
          moveSel(-1);
        }
        break;
      case "down":
        if (detailView) {
          scrollBy(1);
        } else if (inStringsList) {
          if (stringSel < strsLen - 1) {
            stringSel++;
            render();
          } else {
            moveSel(1);
          }
        } else {
          moveSel(1);
        }
        break;
      case "pageup":
        scrollBy(-10);
        break;
      case "pagedown":
        scrollBy(10);
        break;
      case "top":
        if (inStringsList) {
          stringSel = 0;
          render();
        } else {
          sel = 0;
          render();
        }
        break;
      case "bottom":
        if (inStringsList) {
          stringSel = Math.max(0, strsLen - 1);
          render();
        } else {
          sel = Math.max(0, sections.length - 1);
          render();
        }
        break;
      case "redraw":
        render();
        break;
      case "quit":
        destroy();
        break;
    }
    return true;
  };

  // The renderer delivers keys to the focused renderable. We make the
  // leftBox the only focusable element and attach the handler to it (and to
  // root, as a backup). We also listen to the global "keypress" event with
  // dedupe for safety.
  root.onKeyDown = handleKey;
  leftBox.onKeyDown = handleKey;
  try {
    renderer.on("keypress", handleKey);
  } catch {
    /* evento inexistente neste runtime: ignora */
  }

  render();

  // Garante que o leftBox detenha o foco e receba as teclas.
  try {
    leftBox.focus();
  } catch {
    /* focus unavailable: ignore */
  }

  // Auto-close for headless validation (e.g. tests/smoke).
  const autoClose = process.env.RETOOL_TUI_AUTOCLOSE_MS;
  if (autoClose) {
    const ms = Number(autoClose);
    if (Number.isFinite(ms) && ms > 0) {
      setTimeout(destroy, ms);
    }
  }

  await new Promise<void>((resolve) => {
    const onDestroy = (): void => resolve();
    renderer.on("destroy", onDestroy);
    // If the renderer was already destroyed before the listener, resolve now.
    try {
      if (renderer.destroyed) resolve();
    } catch {
      /* property does not exist */
    }
    // Safety fallback: never hang the process forever in odd scenarios.
    setTimeout(() => resolve(), 60_000);
  });
}
