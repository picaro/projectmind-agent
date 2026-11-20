/**
 * Closed WireGuard Easy profile. The command payload names this profile.
 * Docker flags are fixed here and are not read from the payload.
 *
 * Digests are ghcr.io/wg-easy/wg-easy:14. Keep them identical to
 * src/lib/hosting/personal-nodes/wireguard-profile.ts.
 */

export const WIREGUARD_ENDPOINT_PROFILE = "wireguard-endpoint" as const;

export const WIREGUARD_EASY_DIGESTS = {
  "linux/arm64": "sha256:f4609def844b7b6039cf2968447a41c5122bbab65291d9cfd504b827888aa608",
  "linux/amd64": "sha256:b81b9e82dc1fac78fb29bb7290f4df236b92599b0549d904ed1df04c981d1623",
} as const;

/** Registry name for the pinned digests. A bare sha256 pull is Docker Hub and is rejected. */
export const WIREGUARD_EASY_REPOSITORY = "ghcr.io/wg-easy/wg-easy";

export function wireguardImageReference(digest: string): string {
  return `${WIREGUARD_EASY_REPOSITORY}@${digest}`;
}

export function isWireguardImageReference(value: string): boolean {
  return (Object.values(WIREGUARD_EASY_DIGESTS) as readonly string[]).some(
    (digest) => value === wireguardImageReference(digest),
  );
}

export const WIREGUARD_ADMIN_PORT = 51821;
export const WIREGUARD_UDP_PORT = 51820;
export const WIREGUARD_UDP_PUBLISH = "0.0.0.0:51820:51820/udp";
export const WIREGUARD_CONFIG_MOUNT = "/etc/wireguard";
export const WIREGUARD_DEVICE = "/dev/net/tun";
export const WIREGUARD_CAP = "NET_ADMIN";
export const WIREGUARD_SYSCTLS = [
  "net.ipv4.ip_forward=1",
  "net.ipv4.conf.all.src_valid_mark=1",
] as const;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function isWireguardEasyDigest(digest: string): boolean {
  return (Object.values(WIREGUARD_EASY_DIGESTS) as readonly string[]).includes(digest);
}

export function parseVpnEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /[\s/:]/.test(trimmed) || trimmed.includes("..")) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
    const parts = trimmed.split(".").map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part > 255)) return null;
    const [first] = parts;
    if (first === 0 || first === 127) return null;
    return trimmed;
  }
  if (!HOSTNAME.test(trimmed)) return null;
  if (trimmed.toLowerCase() === "localhost") return null;
  return trimmed;
}

/** bcrypt hash. wg-easy 14 rejects the plaintext PASSWORD variable. */
export const WIREGUARD_PASSWORD_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function parseWireguardPasswordHash(value: unknown): string | null {
  if (typeof value !== "string" || !WIREGUARD_PASSWORD_HASH.test(value)) return null;
  if (value.includes("..") || value.toLowerCase().includes("docker.sock")) return null;
  return value;
}

export function wireguardRuntimeEnv(
  endpoint: string,
  passwordHash: string,
): Record<string, string> {
  return {
    WG_HOST: endpoint,
    WG_PORT: String(WIREGUARD_UDP_PORT),
    PORT: String(WIREGUARD_ADMIN_PORT),
    PASSWORD_HASH: passwordHash,
  };
}
