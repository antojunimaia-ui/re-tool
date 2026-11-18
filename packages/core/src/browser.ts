// Browser capture (phase 2, no Playwright): drives an already-installed
// Chrome/Edge/Chromium in headless mode over the DevTools Protocol.
//
// Node's global WebSocket is enough for CDP, so this module adds no new
// dependency. It is used by `re-tool web --browser` to get past bot challenges
// that require executing JavaScript (Vercel/Cloudflare checkpoints), and to
// capture XHR/fetch responses, cookies and web storage.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 25000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrowserCaptureOptions {
  /** Explicit browser executable path. */
  browserPath?: string;
  /** Launch/navigation timeout. Default: 25000. */
  timeoutMs?: number;
  /** Extra wait after the load event, for XHR/SPA rendering. Default: 1200. */
  settleMs?: number;
  /** Max bytes of response bodies kept in memory. Default: 32 MB. */
  maxTotalBytes?: number;
  /** Cookie header sent with every request (e.g. "session=abc; theme=dark"). */
  cookie?: string;
  /** Overrides the browser User-Agent. */
  userAgent?: string;
}

export interface CapturedResponse {
  url: string;
  status: number;
  mimeType: string;
  resourceType: string;
  body?: string;
}

export interface StorageItem {
  name: string;
  value: string;
  domain?: string;
}

export interface BrowserCapture {
  url: string;
  status: number;
  contentType: string | null;
  html: string;
  userAgent: string;
  responses: CapturedResponse[];
  storage: {
    cookies: StorageItem[];
    localStorage: StorageItem[];
    sessionStorage: StorageItem[];
  };
}

// ---------------------------------------------------------------------------
// Browser discovery
// ---------------------------------------------------------------------------

const WINDOWS_BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  `${process.env.LOCALAPPDATA ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe`,
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
];

const UNIX_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
];

/**
 * Finds a Chromium-based browser. Order: explicit path, RETOOL_BROWSER env,
 * well-known install locations.
 */
export function findBrowser(explicitPath?: string): string | null {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new ToolError(`Browser not found at ${explicitPath}`);
    }
    return explicitPath;
  }

  const fromEnv = process.env.RETOOL_BROWSER;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates = process.platform === "win32" ? WINDOWS_BROWSERS : UNIX_BROWSERS;
  return candidates.find((p) => p && existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

class CdpConnection {
  private constructor(private readonly ws: WebSocket) {}

  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (err: Error) => void }
  >();
  private handlers = new Set<(msg: { method: string; params: Json }) => void>();

  static async connect(wsUrl: string, timeoutMs: number): Promise<CdpConnection> {
    const ws = new WebSocket(wsUrl);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new ToolError(`Could not connect to CDP at ${wsUrl}`));
      }),
      timeoutMs,
      "CDP connection",
    );

    const conn = new CdpConnection(ws);
    ws.onmessage = (ev: MessageEvent) => {
      let msg: { id?: number; method?: string; params?: Json; result?: Json; error?: Json };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.id && conn.pending.has(msg.id)) {
        const entry = conn.pending.get(msg.id)!;
        conn.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`${msg.error.message ?? "CDP error"} (${JSON.stringify(msg.error)})`));
        } else {
          entry.resolve((msg.result ?? {}) as Json);
        }
        return;
      }

      if (msg.method) {
        for (const fn of conn.handlers) {
          fn({ method: msg.method, params: (msg.params ?? {}) as Json });
        }
      }
    };

    return conn;
  }

  send<T extends Json = Json>(method: string, params: Json = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = this.nextId++;
    return withTimeout(
      new Promise<T>((resolve, reject) => {
        this.pending.set(id, { resolve: resolve as (v: Json) => void, reject });
        try {
          this.ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          this.pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
      timeoutMs,
      `${method}`,
    );
  }

  on(fn: (msg: { method: string; params: Json }) => void): () => void {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolError(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Launch / teardown
// ---------------------------------------------------------------------------

interface LaunchedBrowser {
  proc: ChildProcess;
  profileDir: string;
  port: number;
}

async function launchBrowser(browserPath: string, timeoutMs: number): Promise<LaunchedBrowser> {
  const profileDir = mkdtempSync(path.join(os.tmpdir(), "re-tool-browser-"));

  const proc = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      "--window-size=1366,900",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let port = 0;

  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const first = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
        const parsed = Number(first);
        if (parsed > 0) {
          port = parsed;
          break;
        }
      } catch {
        /* file may still be being written */
      }
    }
    if (proc.exitCode !== null) {
      throw new ToolError(
        `Browser exited during startup (code ${proc.exitCode}). Try another --browser-path.`,
      );
    }
    await sleep(100);
  }

  if (!port) {
    killProcess(proc);
    rmProfile(profileDir);
    throw new ToolError(`Browser did not open the DevTools port within ${timeoutMs} ms.`);
  }

  return { proc, profileDir, port };
}

function killProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === "win32" && proc.pid) {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
}

function rmProfile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* best effort */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageTarget(port: number, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = (await res.json()) as { type: string; webSocketDebuggerUrl: string }[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* browser still starting */
    }
    await sleep(100);
  }
  throw new ToolError("Could not find a page target in the browser.");
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

interface RawResponse {
  requestId: string;
  url: string;
  status: number;
  mimeType: string;
  resourceType: string;
  body?: string;
}

export async function captureWithBrowser(
  input: string,
  opts: BrowserCaptureOptions = {},
): Promise<BrowserCapture> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const settleMs = opts.settleMs ?? 1200;
  const maxTotalBytes = opts.maxTotalBytes ?? 32 * 1024 * 1024;

  const browserPath = findBrowser(opts.browserPath);
  if (!browserPath) {
    throw new ToolError(
      "No Chromium-based browser found. Install Chrome/Edge/Chromium, set RETOOL_BROWSER " +
        "to the executable, or pass --browser-path <path>.",
    );
  }

  const launched = await launchBrowser(browserPath, timeoutMs);
  let conn: CdpConnection | null = null;

  try {
    const wsUrl = await fetchPageTarget(launched.port, timeoutMs);
    conn = await CdpConnection.connect(wsUrl, timeoutMs);

    const responses = new Map<string, RawResponse>();
    let bodyBudget = maxTotalBytes;

    conn.on(({ method, params }) => {
      if (method === "Network.responseReceived") {
        const p = params as {
          requestId: string;
          response: { url: string; status: number; mimeType: string };
          type: string;
        };
        responses.set(p.requestId, {
          requestId: p.requestId,
          url: p.response.url,
          status: p.response.status,
          mimeType: p.response.mimeType,
          resourceType: p.type,
        });
      }
    });

    await conn.send("Network.enable", {
      maxTotalBufferSize: 64 * 1024 * 1024,
      maxResourceBufferSize: 16 * 1024 * 1024,
    });
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");

    if (opts.cookie) {
      // `Network.setExtraHTTPHeaders` does not reliably forward Cookie in
      // Chromium, so write the cookies into the (temporary) profile instead.
      let origin = input;
      try {
        origin = new URL(input).origin + "/";
      } catch {
        /* keep input */
      }
      for (const pair of opts.cookie.split(";")) {
        const index = pair.indexOf("=");
        if (index <= 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (!name) continue;
        await conn.send("Network.setCookie", { name, value, url: origin });
      }
    }
    if (opts.userAgent) {
      await conn.send("Network.setUserAgentOverride", {
        userAgent: opts.userAgent,
        acceptLanguage: "en-US,en;q=0.9",
      });
    }

    // Subscribe before navigating so the initial load event is not missed.
    let onLoad: (() => void) | null = null;
    const loadPromise = new Promise<void>((resolve) => (onLoad = resolve));
    const offLoad = conn.on(({ method }) => {
      if (method === "Page.loadEventFired") onLoad?.();
    });

    const nav = await conn.send<{ errorText?: string }>("Page.navigate", { url: input }, timeoutMs);
    if (nav.errorText) {
      throw new ToolError(`Navigation failed for ${input}: ${nav.errorText}`);
    }
    await Promise.race([loadPromise, sleep(timeoutMs)]);
    offLoad();
    await sleep(settleMs);

    const evaluate = async (expression: string): Promise<unknown> => {
      const res = await conn!.send<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string };
      }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.text ?? "evaluation failed");
      }
      return res.result?.value;
    };

    const finalUrl = String((await evaluate("location.href")) ?? input);
    const html = String((await evaluate("document.documentElement.outerHTML")) ?? "");
    const userAgent = String((await evaluate("navigator.userAgent")) ?? "");
    const storageRaw = await evaluate(`JSON.stringify({
      localStorage: Object.fromEntries(Object.entries(localStorage)),
      sessionStorage: Object.fromEntries(Object.entries(sessionStorage))
    })`);

    let local: Record<string, string> = {};
    let session: Record<string, string> = {};
    try {
      const parsed = JSON.parse(String(storageRaw ?? "{}")) as {
        localStorage?: Record<string, string>;
        sessionStorage?: Record<string, string>;
      };
      local = parsed.localStorage ?? {};
      session = parsed.sessionStorage ?? {};
    } catch {
      /* ignore malformed storage */
    }

    const cookieRes = await conn.send<{
      cookies?: { name: string; value: string; domain: string }[];
    }>("Network.getAllCookies", {}, timeoutMs);
    const cookies: StorageItem[] = (cookieRes.cookies ?? []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
    }));

    // Response bodies (scripts + XHR/fetch) for the rest of the pipeline.
    const captured: CapturedResponse[] = [];
    for (const raw of responses.values()) {
      const item: CapturedResponse = {
        url: raw.url,
        status: raw.status,
        mimeType: raw.mimeType,
        resourceType: raw.resourceType,
      };
      const wanted =
        raw.resourceType === "Script" ||
        raw.resourceType === "XHR" ||
        raw.resourceType === "Fetch" ||
        /javascript|ecmascript/i.test(raw.mimeType);

      if (wanted && bodyBudget > 0) {
        try {
          const body = await conn.send<{ body?: string; base64Encoded?: boolean }>(
            "Network.getResponseBody",
            { requestId: raw.requestId },
            5000,
          );
          if (body.body !== undefined) {
            const text = body.base64Encoded
              ? Buffer.from(body.body, "base64").toString("utf8")
              : body.body;
            const bytes = Buffer.byteLength(text, "utf8");
            if (bytes <= bodyBudget) {
              item.body = text;
              bodyBudget -= bytes;
            }
          }
        } catch {
          /* body already evicted — the asset will be re-fetched over HTTP */
        }
      }
      captured.push(item);
    }

    const documentResponse = captured
      .filter((r) => r.resourceType === "Document")
      .at(-1);

    return {
      url: finalUrl,
      status: documentResponse?.status ?? 200,
      contentType: documentResponse?.mimeType ?? null,
      html,
      userAgent,
      responses: captured,
      storage: {
        cookies,
        localStorage: Object.entries(local).map(([name, value]) => ({ name, value })),
        sessionStorage: Object.entries(session).map(([name, value]) => ({ name, value })),
      },
    };
  } finally {
    try {
      await conn?.send("Browser.close", {}, 2000);
    } catch {
      /* ignore */
    }
    conn?.close();
    killProcess(launched.proc);
    rmProfile(launched.profileDir);
  }
}
