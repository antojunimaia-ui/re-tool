// Generates fixtures/demo-app.asar (a fake mini Electron app) for tests/demos.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = {
  "package.json": '{"name":"demo-app","version":"1.0.0","main":"main.js"}',
  "main.js": `!function(e){var t={};function r(n){if(t[n])return t[n].exports;var o=t[n]={i:n,l:false,exports:{}};return e[n].call(o.exports,o,o.exports,r),o.l=true,o.exports}r.m=e,r.c=t,r.p="";var __webpack_require__=r;var s={};s["secret-token-abc"]="\\x41\\x42\\x43",s.apiUrl="https://api.internal/v2",s.key="Y2xpZW50LXNlY3JldC1rZXk=";(function(){var url=__webpack_require__.p+s.apiUrl;console.log("loading from "+url)})()}([function(module,exports,r){module.exports={greeting:"olá"}},function(module,exports,r){var a=r(0);console.log(a.greeting)},function(module,exports,r){var b=r(1);exports.b=b}])`,
  "renderer.js": `const hint="secret-hint-12345";\nconst url="https://api.demo.example/v1";\nconsole.log(hint, url);\n`,
  "assets/config.json": '{"debug":true,"appId":"com.example.demo"}',
};

const headerFiles = {};
const bodyParts = [];
let offset = 0;

for (const [p, content] of Object.entries(files)) {
  const buf = Buffer.from(content, "utf8");
  const parts = p.split("/");
  let cur = headerFiles;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    cur[seg] ??= { files: {} };
    cur = cur[seg].files;
  }
  cur[parts[parts.length - 1]] = { size: buf.length, offset: String(offset) };
  offset += buf.length;
  bodyParts.push(buf);
}

const json = JSON.stringify({ files: headerFiles });
const header = Buffer.concat([
  Buffer.from([4, 0, 0, 0, 4, 0, 0, 0]),
  Buffer.from(json, "utf8"),
]);
const archive = Buffer.concat([header, ...bodyParts]);

const outPath = path.join(root, "fixtures/demo-app.asar");
writeFileSync(outPath, archive);
console.log(`Generated: ${outPath} (${archive.length} bytes, header ${header.length} bytes)`);
