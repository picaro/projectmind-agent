import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref() {} })),
}));

vi.mock("node:child_process", () => ({
  spawn,
}));

import { runDeviceLogin, upsertEnvVar } from "./device-login.js";

describe("upsertEnvVar", () => {
  it("inserts into an empty file and keeps a trailing newline", () => {
    expect(upsertEnvVar("", "IMEMORY_API_KEY", "imk_new")).toBe("IMEMORY_API_KEY=imk_new\n");
  });

  it("replaces an existing assignment and leaves comments alone", () => {
    const next = upsertEnvVar(
      "# IMEMORY_API_KEY=commented\nIMEMORY_API_KEY=old\nOTHER=1\n",
      "IMEMORY_API_KEY",
      "imk_new",
    );
    expect(next).toBe("# IMEMORY_API_KEY=commented\nIMEMORY_API_KEY=imk_new\nOTHER=1\n");
  });

  it("appends when the file has no trailing newline", () => {
    expect(upsertEnvVar("FOO=1", "IMEMORY_API_KEY", "imk_new")).toBe(
      "FOO=1\nIMEMORY_API_KEY=imk_new\n",
    );
  });
});

describe("runDeviceLogin", () => {
  let dir: string;
  let envPath: string;
  const fetchMock = vi.fn();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pm-device-login-"));
    envPath = join(dir, ".env");
    fetchMock.mockReset();
    spawn.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  function startBody(overrides: Record<string, unknown> = {}) {
    return {
      ok: true,
      json: async () => ({
        device_code: "device",
        user_code: "ABCD-EFGH",
        verification_uri: "https://projectm.dev/device",
        interval: 2,
        ...overrides,
      }),
    };
  }

  function tokenBody(body: Record<string, unknown>, ok = true) {
    return { ok, json: async () => body };
  }

  async function flushStart(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it("returns failure when device-code start is rejected", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error_description: "nope" }),
    });
    await expect(runDeviceLogin({ envPath, timeoutMs: 5_000 })).resolves.toEqual({
      success: false,
      envPath,
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns failure when the start payload has no device code", async () => {
    fetchMock.mockResolvedValueOnce(startBody({ device_code: "" }));
    await expect(runDeviceLogin({ envPath, timeoutMs: 5_000 })).resolves.toMatchObject({
      success: false,
    });
  });

  it("writes the key, mcp url, and project slug, and does not replace an allowlist", async () => {
    await writeFile(envPath, "IMEMORY_WORKSPACE_ALLOWLIST=/keep\n", "utf8");
    fetchMock
      .mockResolvedValueOnce(startBody())
      .mockResolvedValueOnce(
        tokenBody({ access_token: "imk_from_browser", project_slug: "alpha" }),
      );

    const pending = runDeviceLogin({
      envPath,
      timeoutMs: 30_000,
      mcpUrl: "https://projectm.dev/api/mcp",
      appOrigin: "https://projectm.dev/",
    });
    await flushStart();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({
      success: true,
      apiKey: "imk_from_browser",
      projectSlug: "alpha",
      envPath,
    });

    const written = await readFile(envPath, "utf8");
    expect(written).toContain("IMEMORY_API_KEY=imk_from_browser");
    expect(written).toContain("IMEMORY_MCP_URL=https://projectm.dev/api/mcp");
    expect(written).toContain("IMEMORY_PROJECT_SLUG=alpha");
    expect(written).toContain("IMEMORY_WORKSPACE_ALLOWLIST=/keep");
    expect(written.match(/IMEMORY_WORKSPACE_ALLOWLIST=/g)).toHaveLength(1);
    expect(spawn).toHaveBeenCalled();
  });

  it("adds an allowlist of the current directory when the file has none", async () => {
    fetchMock
      .mockResolvedValueOnce(startBody())
      .mockResolvedValueOnce(tokenBody({ access_token: "imgk_token", project_slug: null }));
    const pending = runDeviceLogin({ envPath, timeoutMs: 30_000, appOrigin: "https://projectm.dev" });
    await flushStart();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;
    expect(result.success).toBe(true);
    const written = await readFile(envPath, "utf8");
    expect(written).toContain(`IMEMORY_WORKSPACE_ALLOWLIST=${process.cwd()}`);
  });

  it("clamps a sub-2-second poll interval to 2 seconds", async () => {
    fetchMock
      .mockResolvedValueOnce(startBody({ interval: 1 }))
      .mockResolvedValueOnce(tokenBody({ access_token: "imk_clamped" }));
    const pending = runDeviceLogin({ envPath, timeoutMs: 30_000, appOrigin: "https://projectm.dev" });
    await flushStart();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits out authorization_pending and slow_down, then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(startBody({ interval: 2 }))
      .mockResolvedValueOnce(tokenBody({ error: "authorization_pending" }))
      .mockResolvedValueOnce(tokenBody({ error: "slow_down", interval: 10 }))
      .mockResolvedValueOnce(tokenBody({ access_token: "imk_later" }));

    const pending = runDeviceLogin({ envPath, timeoutMs: 60_000, appOrigin: "https://projectm.dev" });
    await flushStart();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushStart();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushStart();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toMatchObject({ success: true, apiKey: "imk_later" });
  });

  it.each(["access_denied", "expired_token", "server_error"])(
    "stops on %s",
    async (error) => {
      fetchMock
        .mockResolvedValueOnce(startBody())
        .mockResolvedValueOnce(tokenBody({ error, error_description: error }));
      const pending = runDeviceLogin({ envPath, timeoutMs: 30_000, appOrigin: "https://projectm.dev" });
      await flushStart();
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual({ success: false, envPath });
    },
  );

  it("times out when the deadline passes during the first wait", async () => {
    fetchMock
      .mockResolvedValueOnce(startBody())
      .mockResolvedValueOnce(tokenBody({ error: "authorization_pending" }));
    const pending = runDeviceLogin({ envPath, timeoutMs: 500, appOrigin: "https://projectm.dev" });
    await flushStart();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ success: false, envPath });
  });
});
