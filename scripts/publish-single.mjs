// Builds a self-contained single npm package `re-tool` (with re-tool-core and
// re-tool-tui bundled into its node_modules) so only ONE publish is needed.
import { mkdirSync, cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".out", "re-tool");

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "dist"), { recursive: true });

// CLI build
cpSync(path.join(root, "packages/cli/dist"), path.join(out, "dist"), {
  recursive: true,
});

// Bundle internal workspaces as real directories (not symlinks), so npm
// includes them via bundledDependencies.
const internal = {
  "re-tool-core": { dir: "packages/core" },
  "re-tool-tui": { dir: "packages/tui" },
};

for (const [name, { dir }] of Object.entries(internal)) {
  const srcPkg = path.join(root, dir);
  const dst = path.join(out, "node_modules", name);
  mkdirSync(dst, { recursive: true });
  cpSync(path.join(srcPkg, "dist"), path.join(dst, "dist"), { recursive: true });
  cpSync(path.join(srcPkg, "package.json"), path.join(dst, "package.json"));
}

writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: "re-tool",
      version: "0.1.0",
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
        "re-tool-core": "0.1.0",
        "re-tool-tui": "0.1.0",
      },
      bundledDependencies: ["re-tool-core", "re-tool-tui"],
    },
    null,
    2,
  ) + "\n",
);

console.log(`Self-contained package ready at ${out}`);
