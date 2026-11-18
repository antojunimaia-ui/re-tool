import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  auditContent,
  auditTarget,
} from "../dist/index.js";

// ---------------------------------------------------------------------------
// Unit tests: auditContent
// ---------------------------------------------------------------------------

test("auditContent detects critical Electron webPreferences vulnerabilities", () => {
  const badElectronCode = `
    const mainWindow = new BrowserWindow({
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
        enableRemoteModule: true,
      }
    });
  `;

  const findings = auditContent(badElectronCode, "main.js");
  const ids = findings.map((f) => f.id);

  assert.ok(ids.includes("electron-node-integration"));
  assert.ok(ids.includes("electron-context-isolation-disabled"));
  assert.ok(ids.includes("electron-web-security-disabled"));
  assert.ok(ids.includes("electron-allow-running-insecure-content"));
  assert.ok(ids.includes("electron-enable-remote-module"));

  const nodeInteg = findings.find((f) => f.id === "electron-node-integration");
  assert.equal(nodeInteg.severity, "critical");
  assert.equal(nodeInteg.category, "electron");
});

test("auditContent detects hardcoded secrets and masks sensitive snippets", () => {
  const dummyStripe = ["sk", "live", "51Abcdefghijklmnopqrstuv"].join("_");
  const secretCode = `
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const stripeKey = "${dummyStripe}";
  `;

  const findings = auditContent(secretCode, "config.js");
  const aws = findings.find((f) => f.id === "secret-aws-key");
  const stripe = findings.find((f) => f.id === "secret-stripe-key");

  assert.ok(aws);
  assert.equal(aws.severity, "critical");
  assert.match(aws.matchSnippet, /^AKIA.*….*$/); // masked with ellipsis

  assert.ok(stripe);
  assert.equal(stripe.severity, "critical");
  assert.match(stripe.matchSnippet, /^sk_.*….*$/); // masked with ellipsis
});

test("auditContent detects insecure postMessage handlers without origin check", () => {
  const unsafeHandler = `
    window.addEventListener("message", (e) => {
      doAction(e.data);
    });
  `;

  const safeHandler = `
    window.addEventListener("message", (e) => {
      if (e.origin !== "https://trusted.com") return;
      doAction(e.data);
    });
  `;

  const unsafeFindings = auditContent(unsafeHandler, "handler.js");
  assert.ok(unsafeFindings.some((f) => f.id === "postmessage-no-origin-check"));

  const safeFindings = auditContent(safeHandler, "handler.js");
  assert.ok(!safeFindings.some((f) => f.id === "postmessage-no-origin-check"));
});

test("auditContent detects DOM XSS sinks and eval", () => {
  const domCode = `
    element.innerHTML = "<p>" + userInput + "</p>";
    eval("var x = " + param);
  `;

  const findings = auditContent(domCode, "dom.js");
  assert.ok(findings.some((f) => f.id === "dom-xss-sink"));
  assert.ok(findings.some((f) => f.id === "dom-eval"));
});

// ---------------------------------------------------------------------------
// Integration tests: auditTarget
// ---------------------------------------------------------------------------

test("auditTarget audits local file and respects minSeverity filter", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "re-tool-test-audit-"));
  const filePath = path.join(tmpDir, "app.js");

  try {
    const code = `
      // Critical
      const nodeIntegration = true;
      const opts = { nodeIntegration: true };
      // Medium
      div.innerHTML = payload;
      // Low
      const path = "/admin/users";
    `;
    await fs.writeFile(filePath, code, "utf8");

    const fullReport = await auditTarget(filePath, { minSeverity: "info" });
    assert.equal(fullReport.targetType, "file");
    assert.ok(fullReport.stats.totalFindings >= 3);
    assert.ok(fullReport.stats.critical >= 1);
    assert.ok(fullReport.stats.medium >= 1);

    const highReport = await auditTarget(filePath, { minSeverity: "high" });
    assert.ok(highReport.findings.every((f) => f.severity === "high" || f.severity === "critical"));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
