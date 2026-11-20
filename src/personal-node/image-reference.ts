/** A pullable immutable manifest address; a local image ID is a separate form. */
const PINNED_REFERENCE =
  /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/;

export function isPinnedManifestReference(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !PINNED_REFERENCE.test(value))
    return false;
  const authority = value.slice(0, value.indexOf("/"));
  const [host, port] = authority.split(":");
  let canonicalHost: string;
  try {
    canonicalHost = new URL(`https://${authority}`).hostname;
  } catch {
    return false;
  }
  return Boolean(
    host &&
    host.includes(".") &&
    !host.endsWith(".localhost") &&
    !/^\d+(?:\.\d+){3}$/.test(canonicalHost) &&
    (!port || Number(port) <= 65535),
  );
}
