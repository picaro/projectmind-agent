/**
 * Public UDP relay. Run this on the host named by PERSONAL_PORT_RELAY_HOST.
 *
 * PERSONAL_PORT_RELAY_TOKEN     shared with ProjectMind (letters, numbers, "_" or "-")
 * PERSONAL_PORT_RELAY_UDP_PORT  default 51820
 * PERSONAL_PORT_RELAY_CONTROL_PORT default 51819
 * PERSONAL_PORT_RELAY_BIND      default 0.0.0.0
 */
import { startPortRelay } from "./port-relay.ts";

const token = process.env.PERSONAL_PORT_RELAY_TOKEN?.trim() ?? "";
if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
  console.error("PERSONAL_PORT_RELAY_TOKEN must be 8–128 letters, numbers, '_' or '-'.");
  process.exit(1);
}
const udpPort = Number(process.env.PERSONAL_PORT_RELAY_UDP_PORT ?? "51820");
const controlPort = Number(process.env.PERSONAL_PORT_RELAY_CONTROL_PORT ?? "51819");
const host = process.env.PERSONAL_PORT_RELAY_BIND?.trim() || "0.0.0.0";
const relay = await startPortRelay({ token, host, udpPort, controlPort });
console.log(
  `personal port relay udp=${relay.udpPort} control=${relay.controlPort} bind=${relay.host}`,
);
await new Promise(() => undefined);
