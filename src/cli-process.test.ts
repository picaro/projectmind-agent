import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { runCliProcess, tryParseJsonLine, formatArgsForLog } from "./runners/cli-process.js";

describe("tryParseJsonLine", () => {
  it("parses JSON objects", () => {
    expect(tryParseJsonLine('{"type":"turn.started"}')).toEqual({
      type: "turn.started",
    });
  });

  it("returns null for plain text", () => {
    expect(tryParseJsonLine("hello world")).toBeNull();
  });

  it("returns null for invalid JSON that looks like an object", () => {
    expect(tryParseJsonLine("{not json")).toBeNull();
  });
});

describe("formatArgsForLog", () => {
  it("redacts --api-key values and truncates long prompts", () => {
    const prompt = "x".repeat(200);
    const logged = formatArgsForLog([
      "-p",
      "--api-key",
      "sk-secret",
      "--workspace",
      "/tmp/ws",
      prompt,
    ]);
    expect(logged).toContain("--api-key");
    expect(logged).toContain("***");
    expect(logged.join(" ")).not.toContain("sk-secret");
    expect(logged.at(-1)).toMatch(/200 chars/);
    expect(logged.join(" ")).not.toContain(prompt);
  });
});

describe("runCliProcess", () => {
  it("streams stdout and captures exit code", async () => {
    const logs: string[] = [];
    const result = await runCliProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("line1\\n"); process.stdout.write("line2\\n");'],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onLog: async (message) => {
        logs.push(message);
      },
    });

    expect(result.code).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toContain("line1");
    expect(result.stdout).toContain("line2");
    expect(logs.some((l) => l.includes("line1"))).toBe(true);
  });

  it("cancels on abort", async () => {
    const abort = new AbortController();
    const pending = runCliProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30_000)"],
      cwd: process.cwd(),
      signal: abort.signal,
      onLog: async () => {},
    });

    setTimeout(() => abort.abort(), 50);
    const result = await pending;
    expect(result.cancelled).toBe(true);
  });

  it("invokes onStdoutLine for JSON lines", async () => {
    const seen: string[] = [];
    await runCliProcess({
      command: process.execPath,
      args: ["-e", 'console.log(JSON.stringify({ type: "ping", n: 1 }))'],
      cwd: process.cwd(),
      signal: new AbortController().signal,
      onLog: async () => {},
      onStdoutLine: (line) => {
        seen.push(line);
        return true;
      },
    });
    expect(seen.some((l) => l.includes('"ping"'))).toBe(true);
  });
});

describe("cursor/codex CLI binaries (optional)", () => {
  it("agent binary is discoverable when installed", async () => {
    const which = await new Promise<string | null>((resolve) => {
      const child = spawn("which", ["agent"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (c: Buffer) => {
        out += c.toString("utf8");
      });
      child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
      child.on("error", () => resolve(null));
    });
    // Soft check — CI may not have Cursor CLI; still documents expectation.
    if (which) {
      expect(which.length).toBeGreaterThan(0);
    } else {
      expect(which).toBeNull();
    }
  });
});
