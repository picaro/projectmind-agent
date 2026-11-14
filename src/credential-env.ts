import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { envFileHasImemoryApiKey } from "./api-key.js";

/** Same order as startup dotenv loads. The first file with a key wins. */
export function credentialEnvCandidates(cwd: string, execDir: string): string[] {
  return [
    resolve(cwd, ".env"),
    resolve(execDir, ".env"),
    resolve(cwd, "mac-agent/.env"),
    resolve(cwd, "../.env"),
  ];
}

/**
 * File login should update. Prefer the file start already loaded, so a new
 * key does not land in a fresh cwd `.env` and hide the parent allowlist.
 */
export async function resolveActiveCredentialEnvPath(cwd: string, execDir: string): Promise<string> {
  for (const path of credentialEnvCandidates(cwd, execDir)) {
    try {
      const content = await readFile(path, "utf8");
      if (envFileHasImemoryApiKey(content)) return path;
    } catch {
      // missing or unreadable — try the next location
    }
  }
  return resolve(cwd, ".env");
}
