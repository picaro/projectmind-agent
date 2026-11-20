import { readFile } from "node:fs/promises";
import path from "node:path";

const PERSONAL_NODE_ENV_KEY = /^IMEMORY_PERSONAL_NODE_[A-Z0-9_]+$/;

/** Files the engineering CLI reads for its own IMEMORY_PERSONAL_NODE_* keys. */
export function defaultPersonalNodeEnvFiles(cwd: string = process.cwd()): string[] {
  return [path.join(cwd, ".env"), path.join(cwd, ".env.local")];
}

function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

async function readEnvFile(file: string): Promise<Record<string, string> | null> {
  try {
    return parseDotenv(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Copies only IMEMORY_PERSONAL_NODE_* keys from dotenv files.
 * Existing process values win. Other keys, including secrets, are not copied.
 */
export async function applyPersonalNodeEnvFiles(
  env: NodeJS.ProcessEnv,
  files: readonly string[] = defaultPersonalNodeEnvFiles(),
): Promise<NodeJS.ProcessEnv> {
  const next: NodeJS.ProcessEnv = { ...env };
  const fromFiles: Record<string, string> = {};
  for (const file of files) {
    const parsed = await readEnvFile(file);
    if (!parsed) continue;
    for (const [key, value] of Object.entries(parsed)) {
      if (!PERSONAL_NODE_ENV_KEY.test(key)) continue;
      fromFiles[key] = value;
    }
  }
  for (const [key, value] of Object.entries(fromFiles)) {
    if (next[key] === undefined || next[key] === "") next[key] = value;
  }
  return next;
}
