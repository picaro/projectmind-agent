/**
 * ProjectMind API key prefixes:
 * - imk_  project-scoped
 * - imgk_ user-global (default from browser pairing)
 * - imbk_ bucket-scoped
 */
const API_KEY_PREFIX_RE = /^(imk_|imgk_|imbk_)/;

export function isImemoryApiKey(value: string | undefined | null): boolean {
  const trimmed = value?.trim() ?? "";
  return API_KEY_PREFIX_RE.test(trimmed);
}

/** True when a .env body has a usable IMEMORY_API_KEY (any supported prefix). */
export function envFileHasImemoryApiKey(content: string): boolean {
  const match = content.match(/^\s*IMEMORY_API_KEY\s*=\s*(.*)$/m);
  if (!match) return false;
  let raw = match[1].trim();
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
  }
  return isImemoryApiKey(raw);
}
