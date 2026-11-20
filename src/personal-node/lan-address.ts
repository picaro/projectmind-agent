import { parseVpnEndpoint } from "./wireguard-profile.ts";

/**
 * One IPv4 address phones on the same network can dial.
 * Wi-Fi and Ethernet only. Tunnel, loopback, and link-local addresses are not reachable by peers.
 */

export type LanNic = {
  address: string;
  family: string | number;
  internal: boolean;
};

const LAN_INTERFACE = /^(?:en|eth)\d/;

function isIpv4(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

function isLinkLocal(address: string): boolean {
  return address.startsWith("169.254.");
}

/** Private ranges peers on a home network actually use: 10/8, 172.16/12, 192.168/16. */
function isPrivateIpv4(address: string): boolean {
  const [first, second] = address.split(".").map((part) => Number(part));
  if (first === 10) return true;
  if (first === 192 && second === 168) return true;
  if (first === 172 && second !== undefined && second >= 16 && second <= 31) return true;
  return false;
}

export function selectLanAddress(
  interfaces: Record<string, readonly LanNic[] | undefined> | null | undefined,
): string | null {
  if (!interfaces) return null;
  const candidates: Array<{ name: string; address: string; privateNet: boolean }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!LAN_INTERFACE.test(name) || !entries) continue;
    for (const entry of entries) {
      if (!isIpv4(entry.family) || entry.internal) continue;
      const address = parseVpnEndpoint(entry.address);
      if (!address || isLinkLocal(address)) continue;
      candidates.push({ name, address, privateNet: isPrivateIpv4(address) });
    }
  }
  candidates.sort((left, right) => {
    if (left.privateNet !== right.privateNet) return left.privateNet ? -1 : 1;
    if (left.name !== right.name) return left.name < right.name ? -1 : 1;
    return left.address < right.address ? -1 : 1;
  });
  return candidates[0]?.address ?? null;
}
