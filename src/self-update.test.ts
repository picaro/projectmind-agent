import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  getAgentBuildDate,
  getAgentVersion,
  isNewerVersion,
} from "./agent-version.js";
import {
  detectInstall,
  isAutoUpdateEnabled,
  manifestUrlForBase,
  parseUpdateCheckIntervalMs,
  pickUpdateAsset,
  resolveDownloadUrl,
  resolveUpdateBaseUrl,
  checkForAgentUpdate,
  type AgentUpdateManifest,
} from "./self-update.js";

const sampleManifest = (version = "0.3.0"): AgentUpdateManifest => ({
  version,
  releasedAt: "2026-07-24T00:00:00.000Z",
  assets: [
    {
      id: "macos-arm64",
      os: "macos",
      arch: "arm64",
      filename: "imemory-agent-macos-arm64.zip",
      url: "/downloads/agent/imemory-agent-macos-arm64.zip",
    },
    {
      id: "macos-x64",
      os: "macos",
      arch: "x64",
      filename: "imemory-agent-macos-x64.zip",
      url: "/downloads/agent/imemory-agent-macos-x64.zip",
    },
    {
      id: "windows-x64",
      os: "windows",
      arch: "x64",
      filename: "imemory-agent-windows-x64.zip",
      url: "/downloads/agent/imemory-agent-windows-x64.zip",
    },
    {
      id: "ubuntu-x64",
      os: "ubuntu",
      arch: "x64",
      filename: "imemory-agent-ubuntu-x64.zip",
      url: "/downloads/agent/imemory-agent-ubuntu-x64.zip",
    },
    {
      id: "nodejs",
      os: "nodejs",
      arch: "any",
      filename: "imemory-agent-nodejs.zip",
      url: "/downloads/agent/imemory-agent-nodejs.zip",
    },
  ],
});

describe("agent-version", () => {
  it("compares semver numerically", () => {
    expect(compareSemver("0.3.0", "0.2.0")).toBeGreaterThan(0);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
    expect(compareSemver("0.2.1", "0.2.10")).toBeLessThan(0);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.2.0")).toBe(false);
  });

  it("prefers embedded version env", () => {
    expect(
      getAgentVersion({
        env: { IMEMORY_AGENT_EMBEDDED_VERSION: " 9.9.9 " } as NodeJS.ProcessEnv,
      }),
    ).toBe("9.9.9");
  });

  it("normalizes an embedded build date and rejects invalid values", () => {
    expect(
      getAgentBuildDate({
        IMEMORY_AGENT_EMBEDDED_BUILD_DATE: "2026-07-26T12:34:56Z",
      } as NodeJS.ProcessEnv),
    ).toBe("2026-07-26T12:34:56.000Z");
    expect(
      getAgentBuildDate({
        IMEMORY_AGENT_EMBEDDED_BUILD_DATE: "not-a-date",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("self-update helpers", () => {
  it("resolves update base URL from MCP URL", () => {
    expect(resolveUpdateBaseUrl("https://projectm.dev/api/mcp", {} as NodeJS.ProcessEnv)).toBe("https://projectm.dev");
    expect(resolveUpdateBaseUrl("http://localhost:8080/api/mcp", {} as NodeJS.ProcessEnv)).toBe("http://localhost:8080");
    expect(
      resolveUpdateBaseUrl("https://projectm.dev/api/mcp", {
        IMEMORY_AGENT_UPDATE_URL: "https://cdn.example/agent-base/",
      } as NodeJS.ProcessEnv),
    ).toBe("https://cdn.example/agent-base");
  });

  it("builds manifest and download URLs", () => {
    expect(manifestUrlForBase("https://projectm.dev")).toBe(
      "https://projectm.dev/downloads/agent/manifest.json",
    );
    expect(resolveDownloadUrl("https://projectm.dev", "/downloads/agent/x.zip")).toBe(
      "https://projectm.dev/downloads/agent/x.zip",
    );
    expect(resolveDownloadUrl("https://projectm.dev", "https://cdn/x.zip")).toBe(
      "https://cdn/x.zip",
    );
  });

  it("parses auto-update flags and interval", () => {
    expect(isAutoUpdateEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isAutoUpdateEnabled({ IMEMORY_AGENT_AUTO_UPDATE: "0" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(
      parseUpdateCheckIntervalMs({ IMEMORY_AGENT_UPDATE_CHECK_MS: "120000" } as NodeJS.ProcessEnv),
    ).toBe(120000);
    expect(() =>
      parseUpdateCheckIntervalMs({ IMEMORY_AGENT_UPDATE_CHECK_MS: "100" } as NodeJS.ProcessEnv),
    ).toThrow(/60000/);
  });

  it("detects native vs nodejs vs source installs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imemory-agent-detect-"));
    await writeFile(join(dir, "imemory-agent.cjs"), "// stub\n", "utf8");

    expect(
      detectInstall({
        execPath: join(dir, "imemory-agent"),
        cwd: dir,
        argv: [join(dir, "imemory-agent")],
      }).kind,
    ).toBe("native");

    expect(
      detectInstall({
        execPath: "/usr/local/bin/node",
        cwd: dir,
        argv: ["/usr/local/bin/node", join(dir, "imemory-agent.cjs")],
      }),
    ).toEqual({
      kind: "nodejs",
      installDir: dir,
      entryPath: join(dir, "imemory-agent.cjs"),
    });

    const srcDir = await mkdtemp(join(tmpdir(), "imemory-agent-src-"));
    await mkdir(join(srcDir, "src"), { recursive: true });
    expect(
      detectInstall({
        execPath: "/usr/local/bin/node",
        cwd: srcDir,
        argv: ["/usr/local/bin/node", join(srcDir, "src", "index.ts")],
      }).kind,
    ).toBe("source");
  });

  it("picks matching assets for native and nodejs", () => {
    const manifest = sampleManifest();
    expect(
      pickUpdateAsset(
        manifest,
        { kind: "nodejs", installDir: "/", entryPath: "/x" },
        "darwin",
        "arm64",
      )?.id,
    ).toBe("nodejs");
    expect(
      pickUpdateAsset(
        manifest,
        { kind: "native", installDir: "/", entryPath: "/x" },
        "darwin",
        "arm64",
      )?.id,
    ).toBe("macos-arm64");
    expect(
      pickUpdateAsset(
        manifest,
        { kind: "native", installDir: "/", entryPath: "/x" },
        "win32",
        "x64",
      )?.id,
    ).toBe("windows-x64");
    expect(
      pickUpdateAsset(
        manifest,
        { kind: "native", installDir: "/", entryPath: "/x" },
        "linux",
        "x64",
      )?.id,
    ).toBe("ubuntu-x64");
    expect(
      pickUpdateAsset(
        manifest,
        { kind: "source", installDir: "/", entryPath: "/x" },
        "darwin",
        "arm64",
      ),
    ).toBeNull();
  });

  it("checkForAgentUpdate reports available when remote is newer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imemory-agent-check-"));
    await writeFile(join(dir, "imemory-agent.cjs"), "// stub\n", "utf8");
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.2.0" }), "utf8");

    const result = await checkForAgentUpdate("https://projectm.dev/api/mcp", {
      cwd: dir,
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", join(dir, "imemory-agent.cjs")],
      env: {} as NodeJS.ProcessEnv,
      fetchFn: async () =>
        new Response(JSON.stringify(sampleManifest("0.3.0")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.localVersion).toBe("0.2.0");
      expect(result.remoteVersion).toBe("0.3.0");
      expect(result.asset.id).toBe("nodejs");
    }
  });

  it("checkForAgentUpdate skips source installs", async () => {
    const result = await checkForAgentUpdate("https://projectm.dev/api/mcp", {
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", "/repo/mac-agent/src/index.ts"],
      cwd: "/repo/mac-agent",
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("skipped");
  });

  it("checkForAgentUpdate respects disable flag", async () => {
    const result = await checkForAgentUpdate("https://projectm.dev/api/mcp", {
      env: { IMEMORY_AGENT_AUTO_UPDATE: "0" } as NodeJS.ProcessEnv,
    });
    expect(result.status).toBe("disabled");
  });

  it("checkForAgentUpdate reports up_to_date when versions match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imemory-agent-same-"));
    await writeFile(join(dir, "imemory-agent.cjs"), "// stub\n", "utf8");
    await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.3.0" }), "utf8");

    const result = await checkForAgentUpdate("https://projectm.dev/api/mcp", {
      cwd: dir,
      execPath: "/usr/bin/node",
      argv: ["/usr/bin/node", join(dir, "imemory-agent.cjs")],
      env: { IMEMORY_AGENT_EMBEDDED_VERSION: "0.3.0" } as NodeJS.ProcessEnv,
      fetchFn: async () =>
        new Response(JSON.stringify(sampleManifest("0.3.0")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    expect(result).toEqual({
      status: "up_to_date",
      localVersion: "0.3.0",
      remoteVersion: "0.3.0",
    });
  });
});
