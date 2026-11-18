#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "re-tool-core";
import {
  parseArgs,
  type ParsedArgs,
} from "./args.js";
import {
  cmdSearch,
  cmdPos,
  cmdLine,
  cmdExtract,
  cmdScan,
  cmdAsar,
  cmdTui,
  cmdWeb,
  cmdDoctor,
  cmdBeautify,
  packageVersion,
} from "./commands.js";

export * from "./args.js";
export * from "./commands.js";

export const HELP = `
re-tool — reverse engineering assistant (JS/Electron)

Usage:
  re-tool <command> [args] [options]

Commands:
  search <term>     Search for occurrences and show surrounding context
  extract <regex>   Extract regex capture groups (group 1 or full match)
  scan <file>       Run the analysis pipeline (format, strings, summary) → JSON
                    (accepts .asar: analyzes the whole Electron app)
  web <url>         Analyze a live site (HTML + JS bundles)
                    finds frameworks, endpoints, routes, keys, flags
  asar <file>       List the contents of an .asar file (Electron)
  tui              Navigate a report interactively (JSON file or --scan/--web)
  beautify <file>   Reformat (de-minify) code for reading
  pos <offset>      Show a content window around an offset
  line <number>     Show a specific line of the file
  doctor           Check Node, browser, CDP and network for web capture
  version          Print the installed version
  help             Show this help

Common options:
  -f, --file <path>   Target file (default: main.js)
      --json           Structured JSON output
  -c, --context <n>   Context size (default: 400)
  -v, --version       Print the installed version

search options:
  -l, --limit <n>     Max occurrences shown (default: 5; 0 = unlimited)
  -r, --regex         Treat <term> as a regular expression
  -i, --ignore-case   Case-insensitive search
  -a, --all, --no-limit  Show all occurrences

extract options:
  -u, --unique         Remove duplicate captures
      --json           Output a JSON array of captures
      --limit <n>      Max captures (default: 1000; 0 = unlimited)
  -a, --all, --no-limit  Extract all captures

pos options:
  -b, --before <n>    Characters before the offset (default: 100)

asar options:
      --extract        Extract entries to --out
      --match <glob>   With --extract: only matching entries (e.g. "*.js")
  -o, --out <dir>     With --extract: output directory
                      (specific files can be passed as trailing args)

scan options:
      --min-length <n> Ignore strings shorter than this (default: 4)
      --limit <n>      Max strings in the report (default: 750)

web options:
      --json           Print the full report as JSON
  -o, --out <path>     Also write the JSON report to a file
      --min-length <n> Ignore strings shorter than this (default: 4)
      --limit <n>      Max strings per script in the report (default: 50)
      --max-scripts <n> Max scripts downloaded (default: 40; 0 = no limit)
      --timeout <ms>   Per-request timeout (default: 15000)
      --user-agent <ua> Override the User-Agent header
      --cookie <header> Cookie header sent with every request (session=abc; theme=dark)
      --ignore-robots  Skip the robots.txt check (only on authorized targets)
      --browser        Capture with a headless Chrome/Edge (executes JS, gets past
                       JS challenges; also captures XHR, cookies and storage)
      --browser-path <path> Explicit browser executable for --browser
      --headed         Show a real browser window (some challenges reject headless)
      --settle <ms>    Extra wait after load in --browser mode (default: 1200)
      --challenge-wait <ms> Extra wait for a detected challenge to clear
                       (default: 15000 with --headed, 0 headless)
      --allow-challenge Keep going when the page is still a bot challenge
      --tui            Open the TUI right after the analysis
      --preview        Print a static TUI frame
      --engine <name>  TUI engine: ansi (default) | opentui

beautify options:
  -o, --out <path>    Write output to file instead of printing

tui options:
      --scan <file>    Run analysis and open the TUI directly
      --web <url>      Analyze a live site and open the TUI directly
                       (accepts --user-agent, --cookie, --ignore-robots, --browser,
                        --browser-path, --headed, --settle, --challenge-wait,
                        --allow-challenge, --max-scripts, --timeout)
      --preview        Print a static frame (no interaction; ansi engine only)
      --engine <name>  Engine: ansi (default) | opentui (needs Node >= 26.4 or Bun)
      --min-length <n> (with --scan/--web) Ignore shorter strings

Examples:
  re-tool search "token" --file app/bundle.js
  re-tool search "getuserstatus" -i --file main.js
  re-tool search "API_[A-Z_]+" --regex --limit 20 --json
  re-tool extract "\\.lsClient\\.([a-zA-Z0-9_]+)\\(" --file main.js --unique --json
  re-tool scan app/bundle.js --min-length 6
  re-tool web https://example.com
  re-tool web example.com --json --out web-report.json
  re-tool web https://example.com --tui
  re-tool web https://example.com --browser
  re-tool tui --web https://example.com
  re-tool doctor
  re-tool doctor --json
  re-tool beautify app/bundle.js --out bundle.pretty.js
  re-tool tui report.json
  re-tool tui --scan app/bundle.js
  re-tool pos 4096 --file app/main.js --context 200
  re-tool line 42 --file app/main.js
  re-tool asar app.asar --extract --out dist/
  re-tool asar app.asar --extract --out dist/ renderer.js main.js
  re-tool asar app.asar --extract --out dist/ --match "*.js"
`;

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { positional, options, bools } = parseArgs(argv);

  const command = positional[0];
  if (command === "version" || bools.has("version") || bools.has("v")) {
    console.log(`re-tool ${packageVersion()}`);
    return;
  }
  if (!command || command === "help") {
    console.log(HELP);
    return;
  }

  const args: ParsedArgs = { positional, options, bools };
  try {
    switch (command) {
      case "search":
        await cmdSearch(args);
        break;
      case "pos":
        await cmdPos(args);
        break;
      case "line":
        await cmdLine(args);
        break;
      case "scan":
        await cmdScan(args);
        break;
      case "web":
        await cmdWeb(args);
        break;
      case "extract":
        await cmdExtract(args);
        break;
      case "beautify":
        await cmdBeautify(args);
        break;
      case "asar":
        await cmdAsar(args);
        break;
      case "tui":
        await cmdTui(args);
        break;
      case "doctor":
        await cmdDoctor(args);
        break;
      default:
        throw new ToolError(`Unknown command: "${command}". Use "re-tool help".`, 2);
    }
  } catch (err) {
    if (err instanceof ToolError) {
      console.error(`[re-tool] Error: ${err.message}`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

// Auto-run if executed directly as a script
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  runCli().catch((err) => {
    console.error("[re-tool] Unexpected error:", err);
    process.exit(1);
  });
}
