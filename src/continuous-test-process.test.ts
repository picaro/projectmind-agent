import { describe, expect, it } from "vitest";
import {
  buildChildEnv,
  forbiddenEnvKeys,
  isProcessGroupAlive,
  spawnProcessGroup,
  terminateProcessGroup,
} from "./continuous-test-process.js";

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
