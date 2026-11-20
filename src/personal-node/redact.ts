/** Remove device tokens, pairing codes, and public URLs from text that might be logged. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/pnd_[A-Za-z0-9_-]+/g, "[redacted]");
  out = out.replace(/https?:\/\/\S+/gi, "[url]");
  return out;
}
