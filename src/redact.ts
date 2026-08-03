/**
 * Scrub credentials out of anything that gets logged.
 *
 * git and gh write the remote URL — and occasionally the credential itself —
 * into stderr, and the agent forwards stderr verbatim to appendLog, which is
 * persisted by the control plane and rendered in the UI. Everything that leaves
 * this process as text goes through here first.
 */

/** GitHub token shapes: ghs_ (installation), ghp_/gho_/ghu_/ghr_ (user/PAT). */
const GITHUB_TOKEN_PATTERN = /\bgh[psour]_[A-Za-z0-9]{20,}\b/g;

/** Credentials embedded in a URL, e.g. https://x-access-token:ghs_xxx@github.com/... */
const URL_CREDENTIAL_PATTERN = /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g;

const REDACTED = "***";

/**
 * Remove known secrets and anything that looks like a token.
 *
 * `secrets` catches values we were handed directly (which may not match any
 * known pattern); the patterns catch tokens we were never told about.
 */
export function redactSecrets(
  text: string,
  secrets: Array<string | null | undefined> = [],
): string {
  if (!text) return text;

  let out = text;

  for (const secret of secrets) {
    const value = secret?.trim();
    // Guard against short/empty values that would blank out the whole string.
    if (!value || value.length < 8) continue;
    out = out.split(value).join(REDACTED);
  }

  out = out.replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED}@`);
  out = out.replace(GITHUB_TOKEN_PATTERN, REDACTED);

  return out;
}
