import path from "node:path";
import { ToolError } from "re-tool-core";

export interface ParsedArgs {
  positional: string[];
  options: Map<string, string>;
  multiOptions: Map<string, string[]>;
  bools: Set<string>;
}

/** Flags that never consume the next token (purely boolean). */
export const BOOL_FLAGS = new Set([
  "help",
  "h",
  "json",
  "regex",
  "r",
  "preview",
  "ignore-case",
  "i",
  "unique",
  "u",
  "all",
  "a",
  "no-limit",
  "extract",
  "ignore-robots",
  "tui",
  "browser",
  "headed",
  "allow-challenge",
  "no-node-modules",
  "version",
  "v",
  "backup",
  "no-backup",
  "pack",
  "in-place",
  "hex",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string>();
  const multiOptions = new Map<string, string[]>();
  const bools = new Set<string>();

  const isBool = (key: string): boolean => BOOL_FLAGS.has(key);

  const addOption = (key: string, val: string): void => {
    options.set(key, val);
    const existing = multiOptions.get(key);
    if (existing) existing.push(val);
    else multiOptions.set(key, [val]);
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq !== -1 ? a.slice(2, eq) : a.slice(2);
      if (eq !== -1) {
        if (isBool(key)) bools.add(key);
        else addOption(key, a.slice(eq + 1));
      } else if (isBool(key)) {
        bools.add(key);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          addOption(key, next);
          i++;
        } else {
          bools.add(key);
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      const key = a.slice(1);
      if (isBool(key)) {
        bools.add(key);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          addOption(key, next);
          i++;
        } else {
          bools.add(key);
        }
      }
    } else {
      positional.push(a);
    }
  }

  return { positional, options, multiOptions, bools };
}

export function optValue(options: Map<string, string>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = options.get(n);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function optValues(multiOptions: Map<string, string[]>, ...names: string[]): string[] {
  const result: string[] = [];
  for (const n of names) {
    const arr = multiOptions.get(n);
    if (arr) result.push(...arr);
  }
  return result;
}

export function hasFlag(bools: Set<string>, options: Map<string, string>, ...names: string[]): boolean {
  for (const n of names) {
    if (bools.has(n) || options.has(n)) return true;
  }
  return false;
}

export function parseNonNegativeInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 0) {
    throw new ToolError(`${label} must be an integer >= 0 (got: "${raw}").`);
  }
  return v;
}

export const DEFAULT_FILE = "main.js";

/** Normalizes a target path (Windows backslashes, relative paths, etc.). */
export function resolveTarget(p: string): string {
  try {
    return path.resolve(p);
  } catch {
    return p;
  }
}

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const colorized = process.stdout.isTTY;

/** Highlights the found term (only when output is a terminal). */
export function highlight(text: string): string {
  return colorized ? `${BOLD}${RED}${text}${RESET}` : text;
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
