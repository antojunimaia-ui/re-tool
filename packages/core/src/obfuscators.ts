// Heuristic detection of JavaScript obfuscation.
// Each profile sums signals (identifiers, hex escapes, control flow
// flattening, string array accesses, packers) into a finding with confidence 0..1.

export interface ObfuscatorFinding {
  name: string;
  confidence: number;
  signals: string[];
}

export function detectObfuscators(content: string): ObfuscatorFinding[] {
  const findings: ObfuscatorFinding[] = [];

  // --- Profile 1: javascript-obfuscator (and similar) ---
  const hexIdentifiers = (content.match(/_0x[0-9a-fA-F]{4,}/g) ?? []).length;
  const hexStrings = (content.match(/\\x[0-9a-fA-F]{2}/g) ?? []).length;
  const hasSwitchLoop =
    /while\s*\(\s*(?:!?0|true)\s*\)\s*\{\s*switch\s*\(/.test(content);
  const hasStringArrayAccess = /_0x[0-9a-fA-F]+\[[^\]]+\]/.test(content);

  let conf = 0;
  const signals: string[] = [];

  if (hexIdentifiers >= 10) {
    conf += 0.45;
    signals.push(`${hexIdentifiers} _0x… identifiers`);
  } else if (hexIdentifiers > 0) {
    conf += 0.05;
    signals.push(`_0x… identifiers present (${hexIdentifiers})`);
  }

  if (hexStrings >= 30) {
    conf += 0.35;
    signals.push(`${hexStrings} hex escapes in strings`);
  } else if (hexStrings >= 10) {
    conf += 0.15;
    signals.push(`${hexStrings} hex escapes in strings`);
  } else if (hexStrings > 0) {
    conf += 0.03;
    signals.push(`hex escapes present (${hexStrings})`);
  }

  if (hasSwitchLoop) {
    conf += 0.3;
    signals.push("control flow flattening (while + switch)");
  }

  if (hasStringArrayAccess) {
    conf += 0.15;
    signals.push("string array access with dynamic index");
  }

  if (conf >= 0.5) {
    findings.push({
      name: "javascript-obfuscator",
      confidence: Math.min(0.99, Number(conf.toFixed(2))),
      signals,
    });
  }

  // --- Profile 2: Dean Edwards packer (eval(function(p,a,c,k,e,r){...})) ---
  const packer = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*r\s*\)/.test(
    content,
  );
  if (packer) {
    findings.push({
      name: "dean-edwards-packer",
      confidence: 0.92,
      signals: ["signature eval(function(p,a,c,k,e,r){...})"],
    });
  }

  return findings;
}
