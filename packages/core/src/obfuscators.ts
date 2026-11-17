// Detecção heurística de ofuscação de JavaScript.
// Cada perfil soma sinais (identificadores, escapes hex, flattening de fluxo,
// acessos a array de strings, packers) e vira um achado com confiança 0..1.

export interface ObfuscatorFinding {
  name: string;
  confidence: number;
  signals: string[];
}

export function detectObfuscators(content: string): ObfuscatorFinding[] {
  const findings: ObfuscatorFinding[] = [];

  // --- Perfil 1: javascript-obfuscator (e similares) ---
  const hexIdentifiers = (content.match(/_0x[0-9a-fA-F]{4,}/g) ?? []).length;
  const hexStrings = (content.match(/\\x[0-9a-fA-F]{2}/g) ?? []).length;
  const hasSwitchLoop =
    /while\s*\(\s*(?:!?0|true)\s*\)\s*\{\s*switch\s*\(/.test(content);
  const hasStringArrayAccess = /_0x[0-9a-fA-F]+\[[^\]]+\]/.test(content);

  let conf = 0;
  const signals: string[] = [];

  if (hexIdentifiers >= 10) {
    conf += 0.45;
    signals.push(`${hexIdentifiers} identificadores _0x…`);
  } else if (hexIdentifiers > 0) {
    conf += 0.05;
    signals.push(`identificadores _0x… presentes (${hexIdentifiers})`);
  }

  if (hexStrings >= 30) {
    conf += 0.35;
    signals.push(`${hexStrings} escapes hex em strings`);
  } else if (hexStrings >= 10) {
    conf += 0.15;
    signals.push(`${hexStrings} escapes hex em strings`);
  } else if (hexStrings > 0) {
    conf += 0.03;
    signals.push(`escapes hex presentes (${hexStrings})`);
  }

  if (hasSwitchLoop) {
    conf += 0.3;
    signals.push("flattening de fluxo de controle (while + switch)");
  }

  if (hasStringArrayAccess) {
    conf += 0.15;
    signals.push("acesso a array de strings com índice dinâmico");
  }

  if (conf >= 0.5) {
    findings.push({
      name: "javascript-obfuscator",
      confidence: Math.min(0.99, Number(conf.toFixed(2))),
      signals,
    });
  }

  // --- Perfil 2: Dean Edwards packer (eval(function(p,a,c,k,e,r){...})) ---
  const packer = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*r\s*\)/.test(
    content,
  );
  if (packer) {
    findings.push({
      name: "dean-edwards-packer",
      confidence: 0.92,
      signals: ["assinatura eval(function(p,a,c,k,e,r){...})"],
    });
  }

  return findings;
}
