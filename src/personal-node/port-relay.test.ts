import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { connectPortRelay, probePortRelay, startPortRelay } from "./port-relay.ts";

describe("personal port relay", () => {
  it("answers a probe only after the computer connects, and forwards UDP both ways", async () => {
    const relay = await startPortRelay({ token: "relay-token" });
    const local = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => local.bind(0, "127.0.0.1", () => resolve()));
    const localPort = local.address().port;
    local.on("message", (msg, rinfo) => {
      local.send(Buffer.from(`echo:${msg.toString("utf8")}`), rinfo.port, rinfo.address);
    });

    expect(await probePortRelay("127.0.0.1", relay.udpPort, 200)).toBe(false);

    const connector = await connectPortRelay({
      host: "127.0.0.1",
      controlPort: relay.controlPort,
      token: "relay-token",
      localPort,
    });
    expect(await probePortRelay("127.0.0.1", relay.udpPort)).toBe(true);

    const client = dgram.createSocket("udp4");
    const reply = new Promise<string>((resolve) => {
      client.on("message", (msg) => resolve(msg.toString("utf8")));
    });
    client.send(Buffer.from("ping"), relay.udpPort, "127.0.0.1");
    expect(await reply).toBe("echo:ping");

    connector.close();
    client.close();
    local.close();
    await relay.close();
  });
});
