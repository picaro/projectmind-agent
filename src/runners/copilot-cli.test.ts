import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCopilotCliRunner } from "./copilot-cli.js";

function writeScript(body: string): { command: string; record: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-copilot-"));
  const command = path.join(dir, "copilot");
  const record = path.join(dir, "record.txt");
  const recordSh = record.replace(/'/g, `'\\''`);
  fs.writeFileSync(
    command,
    `#!/bin/sh\nRECORD_FILE='${recordSh}'\n${body}\n`,
    { mode: 0o755 },
  );
  return { command, record };
}

const silentLog = async () => {};

describe("createCopilotCliRunner", () => {
  const previousAllow = process.env.IMEMORY_COPILOT_ALLOW_ALL;

  afterEach(() => {
    if (previousAllow === undefined) delete process.env.IMEMORY_COPILOT_ALLOW_ALL;
    else process.env.IMEMORY_COPILOT_ALLOW_ALL = previousAllow;
  });

  it("passes allow-all, the model, extra args, and both token env vars", async () => {
    const { command, record } = writeScript(`
printf '%s\\n' "$@" > "$RECORD_FILE"
printf 'TOKEN=%s\\n' "$COPILOT_GITHUB_TOKEN" >> "$RECORD_FILE"
printf 'GH=%s\\n' "$GH_TOKEN" >> "$RECORD_FILE"
`);
    delete process.env.IMEMORY_COPILOT_ALLOW_ALL;
    const runner = createCopilotCliRunner({
      command,
      apiKey: " ghp_test ",
      model: "gpt-4.1",
      extraArgs: ["--add-dir", "/tmp/ws"],
    });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "ship it",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("succeeded");
    const lines = fs.readFileSync(record, "utf8").trim().split("\n");
    expect(lines.slice(0, 7)).toEqual([
      "-p",
      "ship it",
      "--no-ask-user",
      "--model",
      "gpt-4.1",
      "--allow-all",
      "--add-dir",
    ]);
    expect(lines).toContain("TOKEN=ghp_test");
    expect(lines).toContain("GH=ghp_test");
  });

  it("uses a restricted tool flag when allow-all is disabled and omits a blank token", async () => {
    const { command, record } = writeScript(`
printf '%s\\n' "$@" > "$RECORD_FILE"
if [ -n "$COPILOT_GITHUB_TOKEN" ]; then
  printf 'TOKEN=%s\\n' "$COPILOT_GITHUB_TOKEN" >> "$RECORD_FILE"
else
  printf 'TOKEN=unset\\n' >> "$RECORD_FILE"
fi
`);
    process.env.IMEMORY_COPILOT_ALLOW_ALL = "0";
    const runner = createCopilotCliRunner({ command, apiKey: "   " });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "ship it",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("succeeded");
    expect(result.summary).toBe("Copilot CLI finished");
    const text = fs.readFileSync(record, "utf8");
    expect(text).toContain("--allow-tool=write,shell");
    expect(text).not.toContain("--allow-all");
    expect(text).not.toContain("--model");
    expect(text).toContain("TOKEN=unset");
  });

  it("reports a non-zero exit from the stderr tail", async () => {
    const { command } = writeScript(`
echo "stdout-kept" 
echo "stderr-tail" >&2
exit 3
`);
    const runner = createCopilotCliRunner({ command });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "ship it",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exited with code 3");
    expect(result.error).toContain("stderr-tail");
    expect(result.summary).toContain("stdout-kept");
  });

  it("caps the success summary at 8000 characters", async () => {
    const { command } = writeScript(`
node -e 'process.stdout.write("a".repeat(9000))'
`);
    const runner = createCopilotCliRunner({ command });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "ship it",
      onLog: silentLog,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("succeeded");
    expect(result.summary).toHaveLength(8000);
  });

  it("treats an already-aborted signal as cancelled even when the process exits 0", async () => {
    const { command } = writeScript(`echo done`);
    const controller = new AbortController();
    controller.abort();
    const runner = createCopilotCliRunner({ command });
    const result = await runner.run({
      cwd: process.cwd(),
      prompt: "ship it",
      onLog: silentLog,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
  });
});
