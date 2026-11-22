# re-tool 🛠️

A reverse engineering assistant for **JavaScript/Electron**.

## Structure

```
re-tool/
  packages/core/   → shared analysis engine (format, strings, webpack, source maps, obfuscators, asar, patch, decode, web + browser capture)
  packages/cli/    → `re-tool` binary (search / extract / scan / web / asar / patch / decode / unpack / audit / tui / beautify / pos / line / doctor / version)
  packages/tui/    → interactive terminal UIs (ansi + opentui engines)
  fixtures/        → demo files (webpack, obfuscated, extmap, demo-app.asar)
  scripts/         → reproducible fixture generator
```

- Strict TypeScript, ESM, npm workspaces.
- Canonical output is **JSON** (`--json` / `scan`), with human-friendly text by default.

## Requirements

- Node.js ≥ 20 (tested on v24; the OpenTUI engine needs Node ≥ 26.4 or Bun)
- npm ≥ 10

## Install

```sh
# Published on npm (binary: re-tool)
npm i -g @juniormaia/re-tool
```

> The package is self-contained: `re-tool-core` and `re-tool-tui` are bundled in.

## Build from source

```sh
npm install
npm run build
```

## Usage

```sh
# Search with context (default: main.js in the current directory)
re-tool search "token" --file sample.js

# Case-insensitive search, show all occurrences
re-tool search "GetUserStatus" -i -a --file sample.js

# Extract capture groups (clean token list)
re-tool extract "secret-([a-z]+)-123" --file sample.js
re-tool extract "\.lsClient\.([a-zA-Z0-9_]+)\(" --file main.js --unique --json

# Regex search, more results, JSON output
re-tool search "API_[A-Z_]+" --regex --limit 20 --json

# Analysis pipeline → JSON report
re-tool scan sample.js
re-tool scan fixtures/webpack.min.js --min-length 8

# Analyze a live site (HTML + JS bundles; --browser executes JavaScript)
re-tool web https://example.com
re-tool web example.com --json --out web-report.json
re-tool web https://example.com --tui
re-tool web https://example.com --browser

# Reformat (de-minify) code
re-tool beautify sample.js
re-tool beautify app/bundle.js --out bundle.pretty.js

# Modifying & recompiling Electron apps
re-tool patch ./dist -o app.asar
re-tool patch app.asar --replace main.js=./patched-main.js
re-tool patch app.asar -f main.js -s "isDev = false" --replace-text "isDev = true"
re-tool patch app.asar --remove telemetry.js

# Auto-detect and decode obfuscated tokens/strings
re-tool decode "c2VjcmV0LXRva2VuLTEyMw=="
re-tool decode "48656c6c6f20576f726c64"
re-tool decode "\\x48\\x65\\x6c\\x6c\\x6f"
echo "c2VjcmV0" | re-tool decode

# Content window around an offset / specific line
re-tool pos 4096 --file sample.js --context 200
re-tool line 42 --file sample.js

# Interactive TUI
re-tool tui fixtures/demo-report.json
re-tool tui --scan fixtures/webpack.min.js
re-tool tui --scan fixtures/demo-app.asar
re-tool tui --web https://example.com
```

Without installing: `node packages/cli/dist/index.js <command> ...`

### Commands

| Command | Description |
|---|---|
| `search <term>` | Finds occurrences and shows surrounding context |
| `extract <regex>` | Extracts capture groups (group 1 or full match) |
| `scan <file>` | Analysis pipeline: format, strings, summary → JSON (accepts `.asar`) |
| `web <url>` | Analyzes a live site (HTML + bundles): frameworks, endpoints, routes, keys, flags |
| `asar <file>` | Lists the contents of an `.asar` file (Electron) |
| `patch <file\|dir>` | Modify, inject into, or pack/recompile Electron `.asar` apps |
| `decode [string]` | Auto-detect and decode Base64, Hex, escapes, URL, HTML, JWT |
| `unpack <file>` | Reconstructs original source tree from source maps (`.js`, `.map`, `.asar`) |
| `audit <target>` | Security and attack surface audit (`.asar`, `.js`, live URLs) |
| `tui` | Navigate a report interactively (JSON file, `--scan` or `--web`) |
| `beautify <file>` | Reformat/de-minify code |
| `pos <offset>` | Show a content window around an offset |
| `line <number>` | Show a specific line |
| `doctor` | Check Node, browser, CDP and network for web capture (JSON with `--json`) |
| `version` | Print the installed version (`-v`, `--version` also work) |
| `help` | Full help |

### Options

| Option | Applies to | Default | Description |
|---|---|---|---|
| `-f, --file <path>` | all | `main.js` | Target file |
| `--json` | all | — | Structured JSON output |
| `-c, --context <n>` | search, pos | `400` | Context characters |
| `-l, --limit <n>` | search | `5` | Max occurrences shown (`0` = unlimited) |
| `-r, --regex` | search | — | Treat term as a regular expression |
| `-i, --ignore-case` | search | — | Case-insensitive search |
| `-a, --all, --no-limit` | search, extract | — | Show/extract all results |
| `-u, --unique` | extract | — | Remove duplicate captures |
| `-b, --before <n>` | pos | `100` | Characters before the offset |
| `-s, --size <n>` | line | `400` | Line truncation |
| `--min-length <n>` | scan, web | `4` | Ignore shorter strings |
| `--limit <n>` | scan (`750`), web (`50`) | — | Max strings in the report / per script |
| `-o, --out <path>` | beautify, web, unpack, asar, audit | — | Write output to file or directory |
| `-d, --download <dir>` | web | — | Download discovered files (HTML, JS, CSS) to directory |
| `-m, --match <glob>` | asar, web, unpack | — | Filter entries/files by glob pattern (e.g. `*.js`, `*.tsx`) |
| `--no-node-modules` | unpack | — | Exclude third-party node_modules files from restoration |
| `--severity <level>` | audit | `info` | Minimum severity filter (`critical`, `high`, `medium`, `low`, `info`) |
| `--scan <file>` | tui | — | Analyze then open the TUI |
| `--web <url>` | tui | — | Analyze a live site then open the TUI |
| `--max-scripts <n>` | web | `40` | Max scripts downloaded (`0` = no limit) |
| `--timeout <ms>` | web | `15000` | Per-request timeout |
| `--user-agent <ua>` | web | `re-tool/0.5.0` | Override the User-Agent header |
| `--cookie <header>` | web | — | Cookie header (e.g. `session=abc; theme=dark`) |
| `--ignore-robots` | web | — | Skip the `robots.txt` check (authorized targets only) |
| `--browser` | web | — | Capture with Chrome/Edge over CDP (executes JS, records XHR and storage) |
| `--browser-path <path>` | web | — | Explicit browser executable for `--browser` |
| `--connect <endpoint>` | web | — | Drive an already-running browser over CDP (`http://127.0.0.1:9222` or a `ws://` page target); your browser keeps its real profile, cookies and sessions |
| `--headed` | web | — | Show a real browser window (some challenges reject headless) |
| `--settle <ms>` | web | `1200` | Extra wait after load in `--browser` mode |
| `--watch <seconds>` | web | `0` | Keep observing the page after it settles and record every request/WebSocket frame (runtime network capture; needs `--browser`) |
| `--challenge-wait <ms>` | web | `15000` headed / `0` headless | Extra wait for a detected challenge to clear |
| `--allow-challenge` | web | — | Keep the challenge page in the report instead of failing |
| `--tui` | web | — | Open the TUI right after the analysis |

Exit codes: `0` success · `1` usage/domain error · `2` unknown command.

### `scan` report (`re-tool/report@2`)

The `scan` command emits JSON with:

- `format` — detected bundler + minification
- `webpack` — module graph (`id`, `path`, `deps`, `stringCount`) when applicable (modern or legacy)
- `sourceMap` — recovered map, inline (base64) or external file
- `obfuscators` — obfuscation findings with confidence and signals
- `strings` — literals with offset/line/column/encoding/entropy/function and source snippet
- `summary` — numeric aggregates

### Electron apps (`re-tool/electron-report@1`)

When the `scan` target is an `.asar`, the tool unpacks the archive (own format
reader), inventories the entries, and runs the full pipeline on each internal JS
bundle, aggregating into a single report:

- `asar` — totals (files, bytes, analyzed JS, skipped)
- `files` — per-file analysis (format, webpack, strings, obfuscators, sourceMap)
- `summary` — global aggregates (strings, base64, entropy, files with obfuscation/webpack)

```sh
re-tool scan app.asar --min-length 6
re-tool asar app.asar --json
re-tool asar app.asar --extract --out dist/          # extract everything
re-tool asar app.asar --extract --out dist/ renderer.js main.js
re-tool asar app.asar --extract --out dist/ --match "*.js"
```

Extraction (`--extract`) writes entries to `--out <dir>` (created as needed).
Unpacked entries (`.unpacked/`) and unsafe paths are skipped; pass specific
files as trailing args or filter with `--match <glob>`.

### Modifying & Recompiling Electron apps (`re-tool patch`)

`re-tool patch` allows modifying, injecting into, and recompiling Electron `.asar` applications quickly without requiring external tools:

**Pack an extracted directory back into an `.asar`:**
```sh
# Recompile a directory into an ASAR archive
re-tool patch ./dist -o app.asar

# Automatically extract native addons (.node) into app.asar.unpacked/
re-tool patch ./dist -o app.asar --unpack "*.node"
```

**Directly patch an existing `.asar` archive:**
```sh
# In-place patch with automatic .bak backup
re-tool patch app.asar --replace main.js=./patched-main.js

# Replace multiple files or inject new modules
re-tool patch app.asar \
  --replace main.js=./new-main.js \
  --replace lib/hook.js=./hook.js

# Search & replace code inside a file in the ASAR
re-tool patch app.asar -f main.js -s "isDev = false" --replace-text "isDev = true"

# Regex replacement or code injection (append/prepend)
re-tool patch app.asar -f main.js --regex -s "DEBUG_FLAG\s*=\s*0" --replace-text "DEBUG_FLAG = 1"
re-tool patch app.asar -f main.js --prepend "console.log('App hooked!');\n"

# Remove unwanted telemetry or analytics scripts
re-tool patch app.asar --remove telemetry.js --remove analytics.js

# Save to a new file instead of modifying in-place
re-tool patch app.asar -o patched-app.asar --no-backup
```

### Multi-format string decoding (`re-tool decode`)

`re-tool decode` automatically recognizes encoding formats and decodes obfuscated tokens, strings, or payloads without manual trial and error:

Supported formats:
- **Base64** (`c2VjcmV0...`) & **Base64 URL-safe** (`c2Vj-cmV0_...`)
- **Hexadecimal** (`736563726574`, with or without `0x`, spaces, or colons)
- **Hex-escaped sequences** (`\x73\x65\x63...`)
- **Unicode-escaped sequences** (`\u0073\u0065...` and `\u{73}`)
- **URL-encoded strings** (`secret%20token`)
- **HTML entities** (`&lt;script&gt;`, decimal `&#65;`, hex `&#x41;`)
- **JWT (JSON Web Tokens)** (decodes header and payload automatically)

```sh
# Auto-detect encoding
re-tool decode "c2VjcmV0LXRva2Vu"

# Pipe via stdin
echo "c2VjcmV0" | re-tool decode

# Read from file
re-tool decode -f payload.b64

# Force specific encoding
re-tool decode "deadbeef" --as hex

# Show all candidate decodings ordered by confidence
re-tool decode "deadbeef" --all

# Binary payload hex dump
re-tool decode "89504e470d0a1a0a" --hex

# Structured JSON for pipelines
re-tool decode "c2VjcmV0" --json
```

### Source map reconstruction (`re-tool unpack`)

`re-tool unpack <target>` restores the **exact original developer project tree**
from source maps (`sourcesContent`). It strips bundler schemes (`webpack:///`,
`vite:///`, `turbopack:///`, `file:///`), normalizes namespaces, sanitizes illegal
filesystem characters, and blocks path traversal attempts.

Accepts:
- **`.map` files directly** (standalone source map JSON)
- **`.js` / `.mjs` / `.cjs` bundles** (with inline base64 or companion `.map` files)
- **`.asar` archives** (scans all internal JS bundles and `.map` files inside Electron apps)

```sh
# Unpack a standalone sourcemap
re-tool unpack bundle.js.map -o ./src

# Unpack a minified JS bundle (auto-detects inline base64 or companion .map)
re-tool unpack app.min.js -o ./src

# Unpack an entire Electron app's original source code
re-tool unpack app.asar -o ./src

# Exclude third-party node_modules to keep only first-party application code
re-tool unpack app.asar -o ./src --no-node-modules

# Filter by glob pattern or specific files
re-tool unpack bundle.js.map -o ./src --match "*.tsx"
re-tool unpack bundle.js.map -o ./src index.ts auth.ts
```

### Security & Attack surface audit (`re-tool audit`)

`re-tool audit <target>` performs static vulnerability and attack surface analysis
across Electron packages (`.asar`), JavaScript bundles, or live websites.

**What it detects**:
- **Electron Security**: `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false`,
  `allowRunningInsecureContent`, `enableRemoteModule`, unvalidated `shell.openExternal`, synchronous IPC (`sendSync`),
  and `child_process` execution.
- **Hardcoded Secrets**: AWS keys, live Stripe keys, GitHub tokens, Slack tokens/webhooks, private keys (with automatic masking).
- **Web & DOM Risks**: `window.postMessage` handlers without `event.origin` validation, dangerous DOM sinks (`innerHTML`, `document.write`), and `eval()`.
- **Sensitive Endpoints**: Exposed internal, admin (`/admin/`, `/internal/`, `actuator/env`, `__debug__`) routes.

```sh
# Audit an Electron app
re-tool audit app.asar

# Audit a minified JS bundle, filtering for high and critical issues only
re-tool audit bundle.min.js --severity high

# Audit a live website and output structured JSON
re-tool audit https://example.com --json -o audit-report.json
```

### Web targets (`re-tool/web-report@1`)

`re-tool web <url>` analyzes a live site. By default it fetches the HTML over
plain HTTP, resolves `<script>`, `modulepreload` and `preload as=script` assets
(plus inline scripts), runs the same pipeline used by `scan` over each bundle,
and reports:

- `page` — status, content type, title, description, generator, redirects, robots status, capture mode
- `frameworks` — React/Next/Vue/Nuxt/Angular/Svelte, CMS (WordPress, Shopify…),
  analytics (GA/GTM/Segment/Sentry…), auth, captcha and bundlers, each with
  confidence and evidence
- `endpoints` — absolute URLs (`http`/`ws`) and relative API paths found in
  string literals (`/api/...`, GraphQL, sockets); in browser mode, XHR/fetch
  requests made by the page are merged in
- `routes` — SPA-looking paths (`/dashboard`, `/users/:id`, `/product/[slug]`)
- `keys` — publishable/secret keys, Google API keys, JWTs, Sentry DSNs,
  AWS/GitHub/Slack tokens…
- `featureFlags` — `FEATURE_*`/`ENABLE_*`/`FLAG_*` and camelCase flag names
- `assets` — every discovered asset with size/status (stylesheets included)
- `files` — per-script scan results (format, webpack, sourceMap, obfuscators, strings)
- `storage` — cookies, `localStorage` and `sessionStorage` (browser mode only)
- `coverage` — whether every discovered script was analyzed (`complete`/`partial`)
  with a `gaps[]` list explaining what was skipped: `--max-scripts` limit,
  byte-budget, truncated bodies, failed downloads or parse errors. A `partial`
  run never claims to be a full picture of the site
- `summary` — counts and timings

```sh
re-tool web https://example.com
re-tool web example.com --json --out web-report.json
re-tool web https://example.com --tui      # open the TUI right away
re-tool tui --web https://example.com      # equivalent
re-tool web https://example.com --download dist/           # download all discovered files
re-tool web https://example.com --download dist/ main.js   # download specific files
re-tool web https://example.com --download dist/ --match "*.js" # download matching files
re-tool web https://example.com --cookie "session=abc; theme=dark"
```

If a site rejects the honest `re-tool` User-Agent with **403/406/429**, the tool
retries **once** with a browser-like UA and records it in
`page.userAgentFallback`. For pages behind a login, pass your own session with
`--cookie`.

#### Phase 2: real browser capture (`--browser`)

Sites behind JavaScript challenges (Vercel/Cloudflare checkpoints) and SPAs that
render everything at runtime need a real browser. `--browser` drives an already
installed Chrome/Edge/Chromium in **headless mode** over the DevTools Protocol —
no Playwright, no extra dependency (Node's global `WebSocket` is enough):

```sh
re-tool web https://example.com --browser
re-tool web https://example.com --browser --settle 2000       # wait longer for XHR/SPA
re-tool web https://example.com --browser --browser-path "C:\Program Files\Google\Chrome\Application\chrome.exe"
re-tool tui --web https://example.com --browser                # capture and open the TUI
```

What changes in the report:

- `page.capture: "browser"` and the real browser `page.userAgent`
  (`page.headed` tells whether a visible window was used)
- HTML comes from the **rendered DOM** (`document.documentElement.outerHTML`),
  so client-rendered content and JS-injected `<script>` tags are discovered
- script bodies already downloaded by the browser are reused (`assets[].via:
  "browser"`) instead of being fetched again
- `endpoints` also include XHR/fetch request URLs made while loading
- `storage` lists cookies, `localStorage` and `sessionStorage` (full values in
  JSON; masked in the CLI summary and the TUI)

#### Drive your own browser (`--connect`)

`--connect` makes `re-tool web` drive the **browser you already have open** —
with its real profile, cookies and logged-in sessions — instead of launching a
sandboxed one. Useful for analyzing pages behind a login or a challenge you have
already solved in your own browser.

First, start your browser with DevTools enabled on a dedicated port (Chrome and
Edge): 

```sh
# Windows
chrome --remote-debugging-port=9222 --user-data-dir="C:\Users\<you>\chrome-debug"
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug"
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/chrome-debug"
```

> A separate `--user-data-dir` is required: Chrome refuses remote debugging on
> the *default* profile for security. Log in to the sites you need in that
> window first — the session lives in that profile.

Then analyze with your session:

```sh
re-tool web https://app.example.com/account --browser --connect http://127.0.0.1:9222
re-tool tui --web https://app.example.com/account --browser --connect http://127.0.0.1:9222
re-tool web https://app.example.com/account --browser --connect http://127.0.0.1:9222 --watch 10
```

What happens: a **new tab** is opened (about:blank), the tool attaches to it,
runs the full pipeline (capture, `--watch` runtime network, storage — all using
your real cookies), closes *only that tab*, and leaves your browser open. Your
other tabs and the browser process are untouched.

- `page.connect` records the endpoint used; the CLI/TUI label the capture as
  `connected browser`
- `--connect` combines with everything else: `--watch`, `--settle`,
  `--challenge-wait`, `--allow-challenge`. `--headed` is ignored (the browser is
  already visible)
- Use only on targets you are authorized to test — this mode sends your real
  session cookies to them

#### Runtime network capture (`--watch`)

`--watch <seconds>` keeps the browser open *after* the page settles and records
everything that happens during that window — XHR/fetch polling, analytics
beacons, WebSocket traffic. Used to observe what a page does over time instead
of only at load:

```sh
re-tool web https://example.com --browser --watch 10
re-tool tui --web https://example.com --browser --watch 10   # + TUI
```

It adds a `runtime` section to the report:

```jsonc
"runtime": {
  "seconds": 5,
  "requests": [
    { "ts": 1491, "kind": "fetch", "method": "GET", "url": "https://…/api/poll/1",
      "status": 200, "mimeType": "application/json", "bytes": 192 }
  ],
  "websockets": [
    { "ts": 300, "direction": "recv", "payloadLength": 64, "preview": "…" }
  ]
}
```

- `ts` is milliseconds after the watch window started; `kind` is
  `document`/`script`/`xhr`/`fetch`/`websocket`/`other`
- WebSocket payloads are stored as a short masked preview — never full frames
- The final HTML snapshot is taken after the watch, so the DOM reflects any
  changes the observed activity caused
- A `summary.runtimeSeconds` field tells you the window length (0 = not used)

#### Diagnostics

`re-tool doctor` checks the environment the tool depends on and prints a short
report (JSON with `--json`):

```sh
re-tool doctor
re-tool doctor --json
```

It verifies: Node version (a global `WebSocket` is needed for browser capture),
a Chromium-based browser is installed and its version, that the DevTools
Protocol actually works (it launches a real probe page headlessly), outbound
network, and the active defaults (`--max-scripts`, byte budgets, timeout).
Anything that is missing becomes a warning with a concrete fix, instead of a
mysterious failure later.

#### Bot challenges (Cloudflare Turnstile, DDoS-Guard…)

A headless browser is often fingerprinted and kept on the challenge page
(`cf_chl_opt`/`Just a moment…`). The tool detects that instead of pretending the
interstitial is the site, and fails with guidance. A **visible window** usually
passes the non-interactive challenge:

```sh
re-tool web https://lovable.dev/ --browser --headed --settle 3000
re-tool tui --web https://lovable.dev/ --browser --headed
```

`--challenge-wait <ms>` controls how long to poll for the challenge to clear
(default 15 s with `--headed`). If the site still refuses, reuse your own
session: `--cookie "cf_clearance=..."` (copy it from your browser's devtools).
`--allow-challenge` keeps the challenge page in the report for inspection.

Browser discovery order: `--browser-path`, the `RETOOL_BROWSER` environment
variable, then the usual Chrome/Edge/Chromium install locations. A temporary
profile is used and removed afterwards. `--cookie` values are written into that
temporary profile and `--user-agent` overrides the browser's own UA.
Authenticating a challenge is still subject to the site's terms — only do it for
sessions you own.

> **Authorized use only.** The tool respects `robots.txt` by default
> (`--ignore-robots` overrides it) and identifies itself with a `re-tool`
> User-Agent (a browser UA is used when `--browser` is enabled). Only run it
> against sites you own or are allowed to test. Raw reports can contain live
> credentials — treat them as secrets.

## TUI

`re-tool tui <report.json>` (or `re-tool tui --scan <file>` / `re-tool tui --web <url>`)
opens a terminal viewer:

- **Left**: sections/files (Summary, Format, Webpack, SourceMap, Obfuscators, Strings — files for Electron, Summary/Page/Frameworks/Endpoints/Routes/Keys/Flags/Storage/Assets for web)
- **Right**: detail for the selection, scrollable
- **Footer**: status and key hints

Keys: `↑/↓` or `j/k` navigate · `Enter` select · `PgUp/PgDn` scroll · `/` filter · `Esc` clears filter · `g/G` top/bottom · `r` redraw · `q` quit.

In the **Strings** section you can pick a string with `↑/↓` and press `Enter`
to see exactly where it lives in the file (line, column, offset and a code
snippet with the string highlighted); `Esc` goes back.

Requires an ANSI-capable terminal (Windows Terminal, kitty, iTerm2, …). For a
static frame without interaction: `re-tool tui --preview --scan bundle.js`.

### Engines

| Engine | Description |
|---|---|
| `ansi` (default) | re-tool's own TUI, zero dependencies, works on any Node |
| `opentui` | **Anomaly's OpenTUI** — `@opentui/core` (native Zig core). Needs **Node ≥ 26.4** (with `--experimental-ffi`) or **Bun**. |

```sh
re-tool tui --engine opentui --scan fixtures/webpack.min.js
re-tool tui --engine ansi --scan fixtures/webpack.min.js
```

> **Runtime transparency:** if the current Node is < 26.4, the CLI automatically
> re-launches the command with the project's portable Node 26
> (`.tools/node-v26.13.1-win-x64`). If the portable Node is missing, it tells
> you what to do.

## Tests

```sh
npm test
```

Suites in `packages/core/test/`, `packages/tui/test/` and `packages/cli/test/` (node:test, no extra deps).

## Roadmap

- [x] **M0** — foundation + search/pos/line
- [x] **M1** — analysis pipeline: parser (Acorn), string extraction, beautify, JSON report
- [x] **M2** — webpack: module graph, source maps, obfuscator detection
- [x] **M3** — Electron: `.asar` reader + full app analysis
- [x] **M4** — interactive TUI over the JSON model (ansi + opentui engines)
- [x] **M5** — web targets (no browser): pages, bundles, frameworks, endpoints, routes, keys, flags
- [x] **M6** — browser capture (phase 2): headless CDP, JS challenges, rendered DOM, XHR, cookies/storage
- [ ] **Next** — more obfuscator profiles, JSX/Babel parsing, HTML report

## License

Apache-2.0 © 2026 antojunimaia-ui
