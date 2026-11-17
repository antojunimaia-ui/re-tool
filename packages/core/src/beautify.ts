// Reformatação de código (desminificação) via Prettier.
import prettier from "prettier";

export interface BeautifyResult {
  ok: boolean;
  code: string;
  error?: string;
}

export async function beautify(content: string): Promise<BeautifyResult> {
  try {
    const code = await prettier.format(content, {
      parser: "babel",
      printWidth: 100,
      tabWidth: 2,
      semi: false,
    });
    return { ok: true, code };
  } catch (err) {
    return {
      ok: false,
      code: content,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
