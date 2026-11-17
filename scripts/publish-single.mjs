// Builds a self-contained single npm package (default: `re-tool`) with
// re-tool-core and re-tool-tui bundled into its node_modules, so only ONE
// publish is needed. Usable as a CLI:
//
//   node scripts/publish-single.mjs [options]
import { mkdirSync, cpSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, ".out", "re-tool");

const HELP = `
Usage:
  node scripts/publish-single.mjs [options]

Builds the self-contained single npm package "re-tool" (bundling
re-tool-core and re-tool-tui into node_modules).

Options:
  -o, --out <dir>      Output directory (default: .out/re-tool)
  -n, --name <name>    Package name (default: re-tool)
  -v, --version <ver>  Package version (default: 0.1.0)
      --build          Run "npm run build" at the repo root first
      --pack           Also create the tarball (npm pack) in --out
      --publish        Also run "npm publish" in --out
      --otp <code>     One-time password passed to npm publish
  -h, --help           Show this help
`;

const INTERNAL = {
  "re-tool-core": { dir: "packages/core" },
  "re-tool-tui": { dir: "packages/tui" },
};

function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    name: "re-tool",
    version: "0.1.0",
    build: false,
    pack: false,
    publish: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
      return argv[++i];
    };

    switch (a) {
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
        break;
      case "-o":
      case "--out":
        opts.out = next();
        break;
      case "-n":
      case "--name":
        opts.name = next();
        break;
      case "-v":
      case "--version":
        opts.version = next();
        break;
      case "--build":
        opts.build = true;
        break;
      case "--pack":
        opts.pack = true;
        break;
      case "--publish":
        opts.publish = true;
        break;
      case "--otp":
        opts.otp = next();
        break;
      default:
        throw new Error(`Unknown option: ${a}`);
    }
  }

  return opts;
}

function assembleSinglePackage(opts) {
  if (opts.build) {
    const b = spawnSync("npm run build", {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    });
    if (b.status !== 0) process.exit(b.status ?? 1);
  }

  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(path.join(opts.out, "dist"), { recursive: true });

  // CLI build
  cpSync(path.join(ROOT, "packages/cli/dist"), path.join(opts.out, "dist"), {
    recursive: true,
  });

  // Bundle internal workspaces as real directories (not symlinks), so npm
  // includes them via bundledDependencies.
  for (const [name, { dir }] of Object.entries(INTERNAL)) {
    const srcPkg = path.join(ROOT, dir);
    const dst = path.join(opts.out, "node_modules", name);
    mkdirSync(dst, { recursive: true });
    cpSync(path.join(srcPkg, "dist"), path.join(dst, "dist"), {
      recursive: true,
    });
    cpSync(path.join(srcPkg, "package.json"), path.join(dst, "package.json"));

    // Keep the bundled package version in sync with the requested version.
    const pkgPath = path.join(dst, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.version !== opts.version) {
      pkg.version = opts.version;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    }
  }

  writeFileSync(
    path.join(opts.out, "package.json"),
    JSON.stringify(
      {
        name: opts.name,
        version: opts.version,
        description:
          "Reverse engineering assistant for JavaScript/Electron — search/extract/scan/asar/tui/beautify/pos/line",
        author: "antojunimaia-ui",
        license: "Apache-2.0",
        type: "module",
        bin: { "re-tool": "dist/index.js" },
        files: [
          "dist",
          "node_modules/re-tool-core",
          "node_modules/re-tool-tui",
        ],
        dependencies: {
          "@opentui/core": "^0.9.2",
          acorn: "^8.14.0",
          prettier: "^3.4.0",
          "re-tool-core": opts.version,
          "re-tool-tui": opts.version,
        },
        bundledDependencies: ["re-tool-core", "re-tool-tui"],
      },
      null,
      2,
    ) + "\n",
  );

  console.log(`Self-contained package ready at ${opts.out} (${opts.name}@${opts.version})`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  assembleSinglePackage(opts);

  if (opts.pack) {
    const pack = spawnSync("npm pack", {
      cwd: opts.out,
      stdio: "inherit",
      shell: true,
    });
    if (pack.status !== 0) process.exit(pack.status ?? 1);
  }

  if (opts.publish) {
    const cmd = opts.otp ? `npm publish --otp ${opts.otp}` : "npm publish";
    const pub = spawnSync(cmd, {
      cwd: opts.out,
      stdio: "inherit",
      shell: true,
    });
    process.exit(pub.status ?? 1);
  }
}

main();
