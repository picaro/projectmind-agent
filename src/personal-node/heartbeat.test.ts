import { describe, expect, it } from "vitest";

import { buildHeartbeat } from "./heartbeat.js";

describe("buildHeartbeat", () => {
  it("omits stale observations when Docker is unavailable and strips unknown fields", () => {
    const deploymentId = "550e8400-e29b-41d4-a716-446655440000";
    const containers = [{ deploymentId, status: "running" as const, environment: "do-not-emit" }];
    const down = buildHeartbeat({
      dockerEnabled: true,
      socketReachable: false,
      arch: "amd64",
      containers,
    });
    expect(down.containers).toBeUndefined();
    const up = buildHeartbeat({
      dockerEnabled: true,
      socketReachable: true,
      arch: "amd64",
      containers,
    });
    expect(up.containers).toEqual([{ deploymentId, status: "running", healthStatus: "unknown" }]);
    expect(JSON.stringify(up)).not.toContain("do-not-emit");
    expect(up.capabilities.runtimeImageObservations).toBe(true);
  });
  it("reports runtime unavailable and tunnel unavailable when docker is off", () => {
    const report = buildHeartbeat({ dockerEnabled: false, socketReachable: false, arch: "arm64" });
    expect(report.runtimeStatus).toBe("unavailable");
    expect(report.tunnelStatus).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain("connected");
    expect(report.capabilities.signedMacApp).toBe(false);
  });

  it("stays runtime unavailable when the socket is down", () => {
    const report = buildHeartbeat({ dockerEnabled: true, socketReachable: false, arch: "amd64" });
    expect(report.runtimeStatus).toBe("unavailable");
    expect(report.tunnelStatus).toBe("unavailable");
  });

  it("can report the runtime available and still keeps the tunnel unavailable", () => {
    const report = buildHeartbeat({ dockerEnabled: true, socketReachable: true, arch: "amd64" });
    expect(report.runtimeStatus).toBe("available");
    expect(report.tunnelStatus).toBe("unavailable");
    expect(JSON.stringify(report)).not.toContain("connected");
  });

  it("reports the Wi-Fi address and omits it when this computer has none", () => {
    const withLan = buildHeartbeat({
      dockerEnabled: true,
      socketReachable: true,
      arch: "arm64",
      interfaces: { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] },
    });
    expect(withLan.capabilities.lanAddress).toBe("192.168.1.20");

    const without = buildHeartbeat({
      dockerEnabled: true,
      socketReachable: true,
      arch: "arm64",
      interfaces: {},
    });
    expect(without.capabilities.lanAddress).toBeUndefined();
  });

  it("reports the tunnel available only when the caller says the child is running", () => {
    const up = buildHeartbeat({
      dockerEnabled: false,
      socketReachable: false,
      arch: "arm64",
      tunnelUp: true,
    });
    expect(up.tunnelStatus).toBe("available");
    expect(up.runtimeStatus).toBe("unavailable");
    expect(JSON.stringify(up)).not.toContain("connected");

    const tokenOnly = buildHeartbeat({
      dockerEnabled: true,
      socketReachable: true,
      arch: "arm64",
      tunnelUp: false,
    });
    expect(tokenOnly.runtimeStatus).toBe("available");
    expect(tokenOnly.tunnelStatus).toBe("unavailable");
  });
});
