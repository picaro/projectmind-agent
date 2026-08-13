import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Fallback when package.json / embed is unavailable. Keep in sync with package.json. */
export const AGENT_VERSION_FALLBACK = "0.2.7";

/** Release build timestamp injected by esbuild; unavailable in source checkouts. */
export function getAgentBuildDate(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.IMEMORY_AGENT_EMBEDDED_BUILD_DATE?.trim();
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

/**
 * Resolve the running agent version.
 * Release builds inject `IMEMORY_AGENT_EMBEDDED_VERSION` via esbuild define.
 * Packaged Node.js / source checkouts can also read adjacent package.json.
 */
export function getAgentVersion(
  options: { installDir?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const fromEnvArg = options.env?.IMEMORY_AGENT_EMBEDDED_VERSION?.trim();
  if (fromEnvArg) return fromEnvArg;

  // Release builds replace this identifier via esbuild `define`.
  const embedded = process.env.IMEMORY_AGENT_EMBEDDED_VERSION?.trim();
  if (embedded) return embedded;

  const candidates: string[] = [];
  if (options.installDir) candidates.push(join(options.installDir, "package.json"));
  candidates.push(join(process.cwd(), "package.json"));
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "package.json"));
  } catch {
    // bundled CJS may not expose import.meta.url the same way
  }
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("../package.json");
    candidates.push(pkgPath);
  } catch {
    // ignore
  }

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
      if (version) return version;
    } catch {
      // try next
    }
  }

  return AGENT_VERSION_FALLBACK;
}

/** Compare dotted numeric versions (e.g. 0.2.0). Returns >0 if a>b, <0 if a<b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}

function parseSemverParts(raw: string): number[] {
  const core = String(raw ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[-+]/, 2)[0];
  return core.split(".").map((part) => {
    const n = Number.parseInt(part.replace(/[^\d].*$/, ""), 10);
    return Number.isFinite(n) ? n : 0;
  });
}

export function isNewerVersion(remote: string, local: string): boolean {
  return compareSemver(remote, local) > 0;
}
