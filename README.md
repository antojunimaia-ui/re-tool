# re-tool 🛠️

A reverse engineering assistant for **JavaScript/Electron**.

## Structure

```
re-tool/
  packages/core/   → shared analysis engine (format, strings, webpack, source maps, obfuscators, asar)
  packages/cli/    → `re-tool` binary (search / scan / asar / tui / beautify / pos / line)
  packages/tui/    → interactive terminal UIs (ansi + opentui engines)
  fixtures/        → demo files (webpack, obfuscated, extmap, demo-app.asar)
  scripts/         → reproducible fixture generator
```

- Strict TypeScript, ESM, npm workspaces.
- Canonical output is **JSON** (`--json` / `scan`), with human-friendly text by default.

## Requirements

- Node.js ≥ 20 (tested on v24; the OpenTUI engine needs Node ≥ 26.4 or Bun)
- npm ≥ 10

## Install & build

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

# Reformat (de-minify) code
re-tool beautify sample.js
re-tool beautify app/bundle.js --out bundle.pretty.js

# Content window around an offset / specific line
re-tool pos 4096 --file sample.js --context 200
re-tool line 42 --file sample.js

# Interactive TUI
re-tool tui fixtures/demo-report.json
re-tool tui --scan fixtures/webpack.min.js
re-tool tui --scan fixtures/demo-app.asar
```

Without installing: `node packages/cli/dist/index.js <command> ...`

### Commands

| Command | Description |
|---|---|
| `search <term>` | Finds occurrences and shows surrounding context |
| `extract <regex>` | Extracts capture groups (group 1 or full match) |
| `scan <file>` | Analysis pipeline: format, strings, summary → JSON (accepts `.asar`) |
| `asar <file>` | Lists the contents of an `.asar` file (Electron) |
| `tui` | Navigate a report interactively (JSON file or `--scan`) |
| `beautify <file>` | Reformat/de-minify code |
| `pos <offset>` | Show a content window around an offset |
| `line <number>` | Show a specific line |
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
| `--min-length <n>` | scan | `4` | Ignore shorter strings |
| `--limit <n>` | scan | `750` | Max strings in the report |
| `-o, --out <path>` | beautify | — | Write output to file |
| `--scan <file>` | tui | — | Analyze then open the TUI |

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

## TUI

`re-tool tui <report.json>` (or `re-tool tui --scan <file>`) opens a terminal
viewer:

- **Left**: sections/files (Summary, Format, Webpack, SourceMap, Obfuscators, Strings — or files for Electron)
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

Suites in `packages/core/test/` and `packages/tui/test/` (node:test, no extra deps).

## Roadmap

- [x] **M0** — foundation + search/pos/line
- [x] **M1** — analysis pipeline: parser (Acorn), string extraction, beautify, JSON report
- [x] **M2** — webpack: module graph, source maps, obfuscator detection
- [x] **M3** — Electron: `.asar` reader + full app analysis
- [x] **M4** — interactive TUI over the JSON model (ansi + opentui engines)
- [ ] **Next** — publish to npm, more obfuscator profiles, JSX/Babel parsing, streaming for large `.asar` files, HTML report

## License

Apache-2.0 © 2026 antojunimaia-ui
