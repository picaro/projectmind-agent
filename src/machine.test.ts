import { describe, expect, it, beforeEach } from "vitest";
import {
  agentKeyForHost,
  agentKindFromPlatform,
  collectCpuLoadPercent,
  collectMachineInfo,
  formatHeartbeatDone,
  normalizeMcpBaseUrl,
  resetCpuLoadSampleForTests,
  resolveAgentKey,
} from "./machine.js";

describe("machine", () => {
  beforeEach(() => {
    resetCpuLoadSampleForTests();
  });

  it("collectMachineInfo returns host, key, platform, and ISO timestamp", () => {
    const fixed = new Date("2026-07-17T23:22:00.000Z");
    const info = collectMachineInfo(fixed);
    expect(info.host.length).toBeGreaterThan(0);
    expect(info.at).toBe("2026-07-17T23:22:00.000Z");
    expect(info.agentKey).toBe(agentKeyForHost(info.host));
    expect(info.platform.length).toBeGreaterThan(0);
    expect(["mac", "windows", "other"]).toContain(info.kind);
  });

  it("agentKindFromPlatform maps darwin/win32", () => {
    expect(agentKindFromPlatform("darwin")).toBe("mac");
    expect(agentKindFromPlatform("win32")).toBe("windows");
    expect(agentKindFromPlatform("linux")).toBe("other");
  });

  it("resolveAgentKey prefers IMEMORY_AGENT_KEY override and can persist to file", () => {
    expect(resolveAgentKey("Mac", { IMEMORY_AGENT_KEY: " opaque-key " } as NodeJS.ProcessEnv)).toBe(
      "opaque-key",
    );
    // Use a repo-local temp path so tests don't write to the developer home directory.
    const tmpFile = require("path").resolve(process.cwd(), "src", ".tmp-agent-key");
    // Ensure no leftover file
    try { require("fs").unlinkSync(tmpFile); } catch {}
    const key = resolveAgentKey("Mac", { IMEMORY_AGENT_KEY_FILE: tmpFile } as NodeJS.ProcessEnv);
    expect(key).toBe("host:Mac");
    // Reading the file should return same key
    expect(require("fs").readFileSync(tmpFile, "utf8").trim()).toBe("host:Mac");
    try { require("fs").unlinkSync(tmpFile); } catch {}
  });

  it("formatHeartbeatDone formats host and time", () => {
    expect(
      formatHeartbeatDone({
        host: "Olegs-MacBook-Pro",
        at: "2026-07-17T23:22:00.000Z",
      }),
    ).toBe("host=Olegs-MacBook-Pro at 2026-07-17T23:22:00.000Z");
  });

  it("normalizeMcpBaseUrl strips trailing slashes", () => {
    expect(normalizeMcpBaseUrl("https://projectm.dev/")).toBe("https://projectm.dev");
    expect(normalizeMcpBaseUrl("https://projectm.dev///")).toBe("https://projectm.dev");
    expect(normalizeMcpBaseUrl("http://localhost:8080/api/mcp")).toBe(
      "http://localhost:8080/api/mcp",
    );
  });

  it("collectCpuLoadPercent returns a 0–100 value after bootstrap sample", async () => {
    const pct = await collectCpuLoadPercent({ bootstrapMs: 20 });
    expect(pct).not.toBeNull();
    expect(pct!).toBeGreaterThanOrEqual(0);
    expect(pct!).toBeLessThanOrEqual(100);
  });

  it("collectCpuLoadPercent uses rolling sample without bootstrap on later calls", async () => {
    await collectCpuLoadPercent({ bootstrapMs: 10 });
    await new Promise((r) => setTimeout(r, 20));
    const second = await collectCpuLoadPercent({ bootstrapMs: 0 });
    expect(second).not.toBeNull();
    expect(second!).toBeGreaterThanOrEqual(0);
    expect(second!).toBeLessThanOrEqual(100);
  });
});
