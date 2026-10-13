import { describe, expect, it, vi } from "vitest";
import {
  buildChildEnv,
  forbiddenEnvKeys,
  isProcessGroupAlive,
  spawnProcessGroup,
  terminateProcessGroup,
  type ManagedProcess,
  type ProcessExit,
} from "./continuous-test-process.js";

function fakeProcess(options: {
  hasExited: boolean;
  exit?: ProcessExit;
  onSignal?: (signal: NodeJS.Signals, resolve: (exit: ProcessExit) => void) => void;
}): ManagedProcess & { signals: NodeJS.Signals[] } {
  const signals: NodeJS.Signals[] = [];
  let resolveExit: (exit: ProcessExit) => void = () => {};
  const exited = options.hasExited
    ? Promise.resolve(options.exit ?? { code: 0, signal: null })
    : new Promise<ProcessExit>((resolve) => {
        resolveExit = resolve;
      });
  return {
    pid: 4242,
    exited,
    hasExited: () => options.hasExited,
    stdoutTail: () => "",
    stderrTail: () => "",
    killGroup: (signal) => {
      signals.push(signal);
      options.onSignal?.(signal, resolveExit);
    },
    signals,
  };
}

describe("terminateProcessGroup", () => {
  it("SIGKILLs a group whose leader has already exited", async () => {
    const proc = fakeProcess({
      hasExited: true,
      exit: { code: null, signal: "SIGTERM" },
    });
    await expect(terminateProcessGroup(proc, 50)).resolves.toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect(proc.signals).toEqual(["SIGKILL"]);
  });

  it("sends SIGTERM and then SIGKILL when the leader exits during the grace period", async () => {
    const proc = fakeProcess({
      hasExited: false,
      onSignal: (signal, resolve) => {
        if (signal === "SIGTERM") resolve({ code: null, signal: "SIGTERM" });
      },
    });
    await expect(terminateProcessGroup(proc, 1_000)).resolves.toEqual({
      code: null,
      signal: "SIGTERM",
    });
    expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns null when the group never reports an exit", async () => {
    vi.useFakeTimers();
    const proc = fakeProcess({ hasExited: false });
    const pending = terminateProcessGroup(proc, 100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeNull();
    expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
    vi.useRealTimers();
  });
});

describe("buildChildEnv", () => {
  it("starts from a minimal base, never the agent's secrets, and adds command env", () => {
    const env = buildChildEnv({
      agentEnv: { PATH: "/bin", HOME: "/h", IMEMORY_API_KEY: "secret", GH_TOKEN: "t", LANG: "en_US.UTF-8" },
      tmpDir: "/run/tmp",
      extra: { PLAYWRIGHT_JSON_OUTPUT_NAME: "/run/report.json" },
      commandEnv: { E2E_BASE_URL: "https://x", CI: "1" },
    });
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LANG: "en_US.UTF-8",
      TMPDIR: "/run/tmp",
      npm_config_yes: "false",
      GIT_TERMINAL_PROMPT: "0",
      PLAYWRIGHT_JSON_OUTPUT_NAME: "/run/report.json",
      E2E_BASE_URL: "https://x",
      CI: "1",
    });
  });

  it("flags env keys the control plane may not set", () => {
    expect(
      forbiddenEnvKeys({ CI: "1", NODE_OPTIONS: "x", DYLD_INSERT_LIBRARIES: "x", PATH: "x", npm_config_registry: "x", E2E_BASE_URL: "x" }),
    ).toEqual(["NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "PATH", "npm_config_registry"]);
  });

  it("flags loader and shell keys and leaves ordinary keys alone", () => {
    expect(
      forbiddenEnvKeys({
        FOO: "1",
        NODE_ENV: "test",
        HOME: "/h",
        NODE_PATH: "/n",
        LD_PRELOAD: "x",
        NPM_CONFIG_CACHE: "/c",
        PLAYWRIGHT_BROWSERS_PATH: "/b",
        PLAYWRIGHT_JSON_OUTPUT_FILE: "/f",
        PLAYWRIGHT_JSON_OUTPUT_DIR: "/d",
        TMPDIR: "/t",
        SHELL: "/bin/zsh",
        BASH_ENV: "/e",
        ENV: "/e",
      }),
    ).toEqual([
      "HOME",
      "NODE_PATH",
      "LD_PRELOAD",
      "NPM_CONFIG_CACHE",
      "PLAYWRIGHT_BROWSERS_PATH",
      "PLAYWRIGHT_JSON_OUTPUT_FILE",
      "TMPDIR",
      "SHELL",
      "BASH_ENV",
      "ENV",
    ]);
  });

  it("lets command env replace extra env, including PATH", () => {
    const env = buildChildEnv({
      agentEnv: { PATH: "/bin" },
      tmpDir: "/run/tmp",
      extra: { PATH: "/extra", KEEP: "extra" },
      commandEnv: { PATH: "/cmd", KEEP: "command" },
    });
    expect(env.PATH).toBe("/cmd");
    expect(env.KEEP).toBe("command");
    expect(env.TMPDIR).toBe("/run/tmp");
  });
});

describe.skipIf(process.platform === "win32")("process group termination (real processes)", () => {
  it("SIGTERM → grace → SIGKILL takes down the leader and a grandchild that ignore SIGTERM", async () => {
    const script = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: "ignore" });
      console.log("grandchild", child.pid);
      setInterval(() => {}, 1000);
    `;
    const proc = spawnProcessGroup([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    await expect.poll(() => proc.stdoutTail(), { timeout: 5_000 }).toMatch(/grandchild \d+/);
    const grandchild = Number(proc.stdoutTail().match(/grandchild (\d+)/)![1]);
    expect(isProcessGroupAlive(proc.pid!)).toBe(true);

    const started = Date.now();
    const exit = await terminateProcessGroup(proc, 300);
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(exit?.signal).toBe("SIGKILL");
    await expect.poll(() => isProcessGroupAlive(proc.pid!), { timeout: 3_000 }).toBe(false);
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it("does not use a shell: metacharacters stay literal arguments", async () => {
    const proc = spawnProcessGroup([process.execPath, "-e", "console.log(process.argv[1])", "$(echo pwned); ls"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "" },
    });
    await proc.exited;
    expect(proc.stdoutTail().trim()).toBe("$(echo pwned); ls");
  });
});
