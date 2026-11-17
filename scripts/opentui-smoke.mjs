// Smoke test do @opentui/core (OpenTUI/Anomaly) sob Node 26 + --experimental-ffi.
import { TextRenderable, createCliRenderer } from "@opentui/core";

try {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  renderer.root.add(new TextRenderable(renderer, { content: "OpenTUI OK" }));
  // Aguarda um instante para o renderer despachar frames.
  await new Promise((r) => setTimeout(r, 300));
  await renderer.destroy();
  console.log("SMOKE_OK");
} catch (err) {
  console.error("SMOKE_FAIL:", err?.message ?? err);
  process.exitCode = 1;
}
