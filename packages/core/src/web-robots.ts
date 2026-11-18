// robots.txt parsing and path evaluation.
import { type FetchedResource } from "./web.js";

export interface RobotsResult {
  checked: boolean;
  allowed: boolean;
  rule?: string;
}

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface ParsedRobots {
  groups: { agents: string[]; rules: RobotsRule[] }[];
}

/** Parses robots.txt into groups of (agents, rules). */
export function parseRobotsTxt(text: string): ParsedRobots {
  const groups: ParsedRobots["groups"] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }

    if (key === "disallow" || key === "allow") {
      if (!current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    }
  }

  return { groups };
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  if (pattern === "") return true;
  let regex = "^";
  for (const ch of pattern) {
    if (ch === "*") regex += ".*";
    else regex += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  if (!pattern.endsWith("$")) regex += ".*";
  return new RegExp(regex).test(path);
}

/**
 * Resolves whether `pathname` is allowed for `agent` given robots.txt text.
 * Longest matching pattern wins; on ties, Allow wins.
 */
export function robotsAllows(
  robots: ParsedRobots,
  pathname: string,
  agent = "re-tool",
): { allowed: boolean; rule?: string } {
  const agentToken = agent.toLowerCase();
  let best: { rule: RobotsRule; length: number } | null = null;

  for (const group of robots.groups) {
    const applies = group.agents.some(
      (a) => a === "*" || agentToken.includes(a.split("/")[0]),
    );
    if (!applies) continue;

    for (const rule of group.rules) {
      if (!robotsPatternMatches(rule.pattern, pathname)) continue;
      const length = rule.pattern.length;
      if (
        !best ||
        length > best.length ||
        (length === best.length && rule.allow && !best.rule.allow)
      ) {
        best = { rule, length };
      }
    }
  }

  if (!best) return { allowed: true };
  return {
    allowed: best.rule.allow,
    rule: `${best.rule.allow ? "Allow" : "Disallow"}: ${best.rule.pattern}`,
  };
}

export async function checkRobots(
  pageUrl: URL,
  fetcher: (url: string, opts?: any) => Promise<FetchedResource>,
  opts: { timeoutMs?: number; userAgent?: string; cookie?: string; agent?: string } = {},
): Promise<RobotsResult> {
  const robotsUrl = new URL("/robots.txt", pageUrl).href;
  try {
    const res = await fetcher(robotsUrl, {
      timeoutMs: opts.timeoutMs,
      maxBytes: 512 * 1024,
      userAgent: opts.userAgent,
      accept: "text/plain,*/*",
    });
    if (res.status !== 200) {
      return { checked: true, allowed: true };
    }
    const parsed = parseRobotsTxt(res.text);
    const { allowed, rule } = robotsAllows(parsed, pageUrl.pathname, opts.agent);
    return { checked: true, allowed, rule };
  } catch {
    // A missing/unreachable robots.txt must not block the analysis.
    return { checked: false, allowed: true };
  }
}
