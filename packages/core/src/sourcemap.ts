// Recuperação de source maps: inline (data URI base64) ou arquivo externo.
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface SourceMapInfo {
  present: boolean;
  kind?: "inline" | "file";
  uri?: string;
  version?: number;
  file?: string;
  sources?: string[];
  names?: string[];
  hasSourcesContent?: boolean;
  sourcesContentCount?: number;
  error?: string;
}

const SOURCE_MAPPING_URL = /\/\/[#@]\s*sourceMappingURL=(\S+)/g;

function findSourceMappingUrl(content: string): string | undefined {
  let last: string | undefined;
  for (const m of content.matchAll(SOURCE_MAPPING_URL)) {
    last = m[1];
  }
  return last;
}

function decodeInlineDataUri(uri: string): string {
  const comma = uri.indexOf(",");
  const meta = uri.slice(5, comma); // "data:" ... ","
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(meta)) {
    return Buffer.from(payload, "base64").toString("utf8");
  }
  return decodeURIComponent(payload);
}

function summarizeMap(
  map: any,
  kind: "inline" | "file",
  uri: string,
): SourceMapInfo {
  const sources: string[] = Array.isArray(map.sources) ? map.sources : [];
  const sourcesContent: unknown[] = Array.isArray(map.sourcesContent)
    ? map.sourcesContent
    : [];

  return {
    present: true,
    kind,
    uri,
    version: typeof map.version === "number" ? map.version : undefined,
    file: typeof map.file === "string" ? map.file : undefined,
    sources,
    names: Array.isArray(map.names) ? map.names : undefined,
    hasSourcesContent: sourcesContent.length > 0,
    sourcesContentCount: sourcesContent.filter((s) => typeof s === "string").length,
  };
}

export async function recoverSourceMap(
  content: string,
  filePath: string,
): Promise<SourceMapInfo> {
  const uri = findSourceMappingUrl(content);
  if (!uri) return { present: false };

  try {
    if (uri.startsWith("data:")) {
      const parsed = JSON.parse(decodeInlineDataUri(uri));
      return summarizeMap(parsed, "inline", uri);
    }

    // Arquivo externo, relativo ao diretório do arquivo analisado.
    let mapText: string;
    try {
      mapText = await readFile(path.resolve(path.dirname(filePath), uri), "utf8");
    } catch {
      return {
        present: true,
        kind: "file",
        uri,
        error: `Source map ${uri} not found next to the file.`,
      };
    }
    return summarizeMap(JSON.parse(mapText), "file", uri);
  } catch (err) {
    return {
      present: true,
      kind: uri.startsWith("data:") ? "inline" : "file",
      uri,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
