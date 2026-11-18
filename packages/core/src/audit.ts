// Security and Attack Surface Audit engine for Electron applications, web targets, and JS bundles.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.js";
import { loadAsar, extractAsarFile, type AsarArchive } from "./asar.js";
import { analyzeWeb, type AnalyzeWebOptions } from "./web.js";
import { maskSecret } from "./web-findings.js";

export type AuditSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AuditCategory = "electron" | "secret" | "endpoint" | "dom" | "network";

export interface AuditFinding {
  id: string;
  title: string;
  category: AuditCategory;
  severity: AuditSeverity;
  description: string;
  file?: string;
  line?: number;
  column?: number;
  matchSnippet?: string;
  recommendation: string;
}

export interface AuditReport {
  schema: "re-tool/audit-report@1";
  target: string;
  targetType: "file" | "asar" | "web";
  timestamp: string;
  stats: {
    totalFindings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    filesAudited: number;
  };
  findings: AuditFinding[];
}

export interface AuditOptions {
  /** Minimum severity to include in report. Default: 'info' (all). */
  minSeverity?: AuditSeverity;
  webOptions?: AnalyzeWebOptions;
}

const SEVERITY_LEVELS: Record<AuditSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

interface StaticRule {
  id: string;
  title: string;
  category: AuditCategory;
  severity: AuditSeverity;
  description: string;
  re: RegExp;
  recommendation: string;
  checkSurrounding?: (content: string, matchIndex: number) => boolean;
}

export const SECURITY_RULES: StaticRule[] = [
  // --- Electron webPreferences & Core Security ---
  {
    id: "electron-node-integration",
    title: "Dangerous nodeIntegration enabled",
    category: "electron",
    severity: "critical",
    description:
      "nodeIntegration: true allows renderer processes to directly access Node.js APIs (fs, child_process). If untrusted web content or an XSS vulnerability is loaded, this leads to immediate Remote Code Execution (RCE).",
    re: /\bnodeIntegration\s*:\s*true\b/g,
    recommendation:
      "Disable nodeIntegration (nodeIntegration: false) and expose minimal, sanitized APIs via contextBridge in a preload script.",
  },
  {
    id: "electron-context-isolation-disabled",
    title: "contextIsolation is disabled",
    category: "electron",
    severity: "critical",
    description:
      "contextIsolation: false merges the preload script's JavaScript execution context with the loaded webpage's context, allowing web scripts to manipulate preload prototypes and escalate privileges.",
    re: /\bcontextIsolation\s*:\s*false\b/g,
    recommendation:
      "Enable contextIsolation (contextIsolation: true) on all BrowserWindows and webviews.",
  },
  {
    id: "electron-web-security-disabled",
    title: "webSecurity is disabled",
    category: "electron",
    severity: "critical",
    description:
      "webSecurity: false disables the Same-Origin Policy (SOP), allowing the page to execute arbitrary cross-origin requests and read local files.",
    re: /\bwebSecurity\s*:\s*false\b/g,
    recommendation:
      "Never disable webSecurity in production builds.",
  },
  {
    id: "electron-allow-running-insecure-content",
    title: "allowRunningInsecureContent enabled",
    category: "electron",
    severity: "high",
    description:
      "Allows HTTPS origins to fetch and execute scripts, styles, or plugins over unencrypted HTTP connections (Mixed Content), enabling man-in-the-middle attacks.",
    re: /\ballowRunningInsecureContent\s*:\s*true\b/g,
    recommendation:
      "Keep allowRunningInsecureContent disabled and enforce HTTPS everywhere.",
  },
  {
    id: "electron-enable-remote-module",
    title: "Deprecated and insecure remote module enabled",
    category: "electron",
    severity: "high",
    description:
      "enableRemoteModule: true allows renderers to execute main process methods over IPC with severe sandbox escape risks.",
    re: /\benableRemoteModule\s*:\s*true\b/g,
    recommendation:
      "Migrate away from the remote module to explicit ipcRenderer.invoke / ipcMain.handle handlers.",
  },
  {
    id: "electron-experimental-features",
    title: "experimentalFeatures enabled",
    category: "electron",
    severity: "low",
    description:
      "experimentalFeatures: true enables unfinalized Chromium features which may introduce security regressions or sandbox bypasses.",
    re: /\bexperimentalFeatures\s*:\s*true\b/g,
    recommendation: "Disable experimentalFeatures in production releases.",
  },
  {
    id: "electron-dangerous-child-process",
    title: "child_process execution detected",
    category: "electron",
    severity: "high",
    description:
      "Direct invocation of child_process functions (exec, spawn, execSync) can lead to command injection if user input is unescaped or passed to a shell.",
    re: /\bchild_process(?:\.exec|\.execSync|\.spawn|\.spawnSync)\b/g,
    recommendation:
      "Avoid shell string concatenation; use execFile with an argument array and strict parameter validation.",
  },
  {
    id: "electron-unsafe-open-external",
    title: "shell.openExternal call detected",
    category: "electron",
    severity: "medium",
    description:
      "Calling shell.openExternal without strictly checking that the protocol is 'http:' or 'https:' can open dangerous local schemes (e.g. 'file://', 'smb://') or registered app protocols.",
    re: /\bshell\.openExternal\s*\(/g,
    recommendation:
      "Verify that the target URL starts with http:// or https:// and matches an allowlist of trusted domains.",
  },
  {
    id: "electron-sync-ipc",
    title: "Synchronous IPC sendSync call",
    category: "electron",
    severity: "low",
    description:
      "ipcRenderer.sendSync blocks the renderer event loop until the main process replies, potentially causing UI freezes and denial-of-service.",
    re: /\bipcRenderer\.sendSync\s*\(/g,
    recommendation: "Replace sendSync with asynchronous ipcRenderer.invoke and async/await.",
  },

  // --- Hardcoded Secrets & High-Risk Credentials ---
  {
    id: "secret-aws-key",
    title: "Hardcoded AWS Access Key",
    category: "secret",
    severity: "critical",
    description: "Detected hardcoded AWS access key ID in bundle code.",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    recommendation: "Rotate the exposed AWS credential immediately and use IAM roles or secure backend vaults.",
  },
  {
    id: "secret-private-key",
    title: "Hardcoded Private Cryptographic Key",
    category: "secret",
    severity: "critical",
    description: "Detected an embedded PEM/SSH private key.",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    recommendation: "Never distribute private keys in client applications. Rotate the exposed key immediately.",
  },
  {
    id: "secret-stripe-key",
    title: "Hardcoded Live Secret Stripe Key",
    category: "secret",
    severity: "critical",
    description: "Detected a secret live Stripe API key (sk_live_...).",
    re: /\bsk_live_[0-9a-zA-Z]{16,}\b/g,
    recommendation: "Revoke the Stripe secret key. Only publishable keys (pk_live_...) should exist on clients.",
  },
  {
    id: "secret-github-token",
    title: "Hardcoded GitHub Personal Access Token",
    category: "secret",
    severity: "high",
    description: "Detected a personal access token for GitHub (ghp_... or github_pat_...).",
    re: /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
    recommendation: "Revoke the GitHub token and remove it from source control and client builds.",
  },
  {
    id: "secret-slack-token",
    title: "Hardcoded Slack Token or Webhook",
    category: "secret",
    severity: "high",
    description: "Detected Slack API token or incoming webhook URL.",
    re: /\b(?:xox[abprs]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/T[0-9A-Z_]+\/B[0-9A-Z_]+\/[0-9a-zA-Z]+)\b/g,
    recommendation: "Revoke the token/webhook and proxy notifications through your private backend API.",
  },

  // --- Web / DOM Security & Attack Surface ---
  {
    id: "postmessage-no-origin-check",
    title: "window.postMessage handler without origin validation",
    category: "dom",
    severity: "high",
    description:
      "A message event listener is registered, but the handler may not validate event.origin, allowing any malicious iframe or site to post messages.",
    re: /(?:addEventListener\s*\(\s*['"]message['"]|\bonmessage\s*=)/g,
    checkSurrounding: (content, idx) => {
      // Check next 350 characters for origin validation check (.origin)
      const windowAfter = content.slice(idx, idx + 400);
      return !/\.origin\b/.test(windowAfter);
    },
    recommendation:
      "Always inspect event.origin (e.g. if (event.origin !== 'https://trusted.com') return;) before processing messages.",
  },
  {
    id: "dom-xss-sink",
    title: "Dangerous DOM XSS sink (innerHTML / outerHTML)",
    category: "dom",
    severity: "medium",
    description:
      "Assigning dynamic content to innerHTML, outerHTML or document.write can lead to Cross-Site Scripting (XSS).",
    re: /\b(?:innerHTML|outerHTML|document\.write)\s*=/g,
    recommendation:
      "Use textContent, createElement, or sanitize untrusted HTML using a library like DOMPurify.",
  },
  {
    id: "dom-eval",
    title: "Dynamic code evaluation (eval / Function)",
    category: "dom",
    severity: "medium",
    description:
      "Dynamic code evaluation through eval() or Function() enables arbitrary script execution and defeats compiler optimizations.",
    re: /\b(?:eval\s*\(|new\s+Function\s*\()/g,
    recommendation: "Refactor code to avoid dynamic JavaScript code execution from strings.",
  },
  {
    id: "endpoint-sensitive-admin",
    title: "Exposed Administrative or Internal Endpoint",
    category: "endpoint",
    severity: "low",
    description:
      "References to internal or admin paths (/admin/, /internal/, /actuator/env, /__debug__) found in client bundles.",
    re: /['"]\/(?:admin|internal|actuator|__debug__|\.env)(?:\/[A-Za-z0-9_.-]*)*['"]/gi,
    recommendation: "Verify that internal/administrative routes are protected by backend authentication and RBAC.",
  },
];

/**
 * Calculates 1-based line and column from offset in content string.
 */
function lineAndColAt(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  const line = lines.length;
  const column = lines[lines.length - 1].length + 1;
  return { line, column };
}

/**
 * Audits a single string content against all static security rules.
 */
export function auditContent(content: string, filePath = "content.js"): AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const rule of SECURITY_RULES) {
    rule.re.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = rule.re.exec(content)) !== null) {
      if (rule.checkSurrounding && !rule.checkSurrounding(content, match.index)) {
        continue;
      }

      const { line, column } = lineAndColAt(content, match.index);
      let snippet = match[0];
      if (rule.category === "secret") {
        snippet = maskSecret(snippet);
      }

      findings.push({
        id: rule.id,
        title: rule.title,
        category: rule.category,
        severity: rule.severity,
        description: rule.description,
        file: filePath,
        line,
        column,
        matchSnippet: snippet,
        recommendation: rule.recommendation,
      });

      // Avoid infinite loop on zero-length matches
      if (match.index === rule.re.lastIndex) {
        rule.re.lastIndex++;
      }
    }
  }

  return findings;
}

/**
 * Runs a comprehensive security audit against a local file, .asar archive, or live web URL.
 */
export async function auditTarget(
  target: string,
  opts: AuditOptions = {},
): Promise<AuditReport> {
  const minSev = opts.minSeverity ?? "info";
  const minLevel = SEVERITY_LEVELS[minSev] ?? 0;

  const isWeb = /^https?:\/\//i.test(target);
  const isAsar = /\.asar$/i.test(target);

  let targetType: "file" | "asar" | "web" = "file";
  if (isWeb) targetType = "web";
  else if (isAsar) targetType = "asar";

  const allFindings: AuditFinding[] = [];
  let filesAudited = 0;

  if (isWeb) {
    const webReport = await analyzeWeb(target, opts.webOptions ?? {});
    filesAudited = 1 + webReport.files.length;

    // Convert discovered keys to audit findings
    for (const k of webReport.keys) {
      let severity: AuditSeverity = "medium";
      if (k.kind === "secret-key" || k.kind === "aws-access-key" || k.kind === "private-key") {
        severity = "critical";
      } else if (k.kind === "github-token" || k.kind === "slack-token" || k.kind === "openai-key") {
        severity = "high";
      }

      allFindings.push({
        id: `secret-${k.kind}`,
        title: `Exposed ${k.kind}`,
        category: "secret",
        severity,
        description: `Discovered an embedded ${k.kind} credential in client-side bundle strings.`,
        file: k.source,
        line: k.line,
        matchSnippet: maskSecret(k.value),
        recommendation: `Revoke and rotate the exposed ${k.kind} credential immediately.`,
      });
    }

    // Convert sensitive endpoints to findings
    for (const ep of webReport.endpoints) {
      if (/(?:admin|internal|actuator|__debug__|\.env)/i.test(ep.value)) {
        allFindings.push({
          id: "endpoint-sensitive-admin",
          title: "Exposed Administrative or Internal Endpoint",
          category: "endpoint",
          severity: "low",
          description: `Reference to internal/admin endpoint (${ep.value}) discovered in client-side bundle.`,
          file: ep.source,
          line: ep.line,
          matchSnippet: ep.value,
          recommendation: "Ensure internal and administrative routes enforce strict backend authentication.",
        });
      }
    }

    // Audit string literals from scanned scripts
    for (const file of webReport.files) {
      for (const str of file.strings) {
        const sFindings = auditContent(str.value, file.path);
        for (const sf of sFindings) {
          sf.line = str.line;
          sf.column = str.column;
          allFindings.push(sf);
        }
      }
    }
  } else if (isAsar) {
    const resolvedPath = path.resolve(target);
    const { archive, buffer } = await loadAsar(resolvedPath);

    const jsEntries = archive.entries.filter(
      (e) =>
        !e.unpacked &&
        e.size > 0 &&
        e.size <= 30 * 1024 * 1024 &&
        /\.(?:js|mjs|cjs|html|json)$/i.test(e.path),
    );

    filesAudited = jsEntries.length;

    for (const entry of jsEntries) {
      try {
        const slice = extractAsarFile(buffer, archive, entry);
        const text = slice.toString("utf8");
        const entryFindings = auditContent(text, entry.path);
        allFindings.push(...entryFindings);
      } catch {
        /* ignore read errors */
      }
    }
  } else {
    // Single file
    const resolvedPath = path.resolve(target);
    let text: string;
    try {
      text = await readFile(resolvedPath, "utf8");
    } catch (err) {
      throw new ToolError(`Failed to read file ${target}: ${err}`);
    }

    filesAudited = 1;
    const fileFindings = auditContent(text, path.basename(resolvedPath));
    allFindings.push(...fileFindings);
  }

  // Filter by minimum severity
  const filtered = allFindings.filter((f) => SEVERITY_LEVELS[f.severity] >= minLevel);

  const stats = {
    totalFindings: filtered.length,
    critical: filtered.filter((f) => f.severity === "critical").length,
    high: filtered.filter((f) => f.severity === "high").length,
    medium: filtered.filter((f) => f.severity === "medium").length,
    low: filtered.filter((f) => f.severity === "low").length,
    info: filtered.filter((f) => f.severity === "info").length,
    filesAudited,
  };

  return {
    schema: "re-tool/audit-report@1",
    target,
    targetType,
    timestamp: new Date().toISOString(),
    stats,
    findings: filtered,
  };
}
