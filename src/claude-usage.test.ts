import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getClaudeUsageSnapshot,
  isClaudeUsageClose,
  parseClaudeUsageText,
  resetClaudeUsageCache,
  runClaudeUsageCheck,
} from "./claude-usage.js";

function writeCommand(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-claude-usage-"));
  const command = path.join(dir, "claude");
  fs.writeFileSync(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return command;
}

describe("claude-usage", () => {
  it("parses session and week usage percentages and reset times", () => {
    const raw =
      "You are currently using your subscription to power your Claude Code usage\n\n" +
      "Current session: 30% used · resets Jul 27 at 11pm (America/New_York)\n" +
      "Current week (all models): 4% used · resets Aug 1 at 5pm (America/New_York)\n\n" +
      "What's contributing to your limits usage?";

    const snapshot = parseClaudeUsageText(raw);

    expect(snapshot.sessionPercent).toBe(30);
    expect(snapshot.sessionResetsAt).toBe("Jul 27 at 11pm (America/New_York)");
    expect(snapshot.weekPercent).toBe(4);
    expect(snapshot.weekResetsAt).toBe("Aug 1 at 5pm (America/New_York)");
    expect(snapshot.note).toBe(
      "Session: 30% used (resets Jul 27 at 11pm (America/New_York)) · " +
        "Week: 4% used (resets Aug 1 at 5pm (America/New_York))",
    );
  });

  it("falls back to a truncated raw note when the shape is unrecognized", () => {
    const snapshot = parseClaudeUsageText("Some unexpected usage output");
    expect(snapshot.sessionPercent).toBeNull();
    expect(snapshot.weekPercent).toBeNull();
    expect(snapshot.note).toBe("Some unexpected usage output");
  });

  it("flags usage as close when either session or week crosses the threshold", () => {
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 95, sessionResetsAt: null, weekPercent: 10, weekResetsAt: null },
        90,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 10, sessionResetsAt: null, weekPercent: 95, weekResetsAt: null },
        90,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 10, sessionResetsAt: null, weekPercent: 20, weekResetsAt: null },
        90,
      ),
    ).toBe(false);
    expect(isClaudeUsageClose(null, 90)).toBe(false);
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 90, sessionResetsAt: null, weekPercent: 0, weekResetsAt: null },
        90,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageClose(
        { checkedAt: "", note: "", sessionPercent: 0, sessionResetsAt: null, weekPercent: 0, weekResetsAt: null },
        90,
      ),
    ).toBe(false);
  });

  it("returns null when the usage command fails, is empty, or is not JSON", async () => {
    await expect(runClaudeUsageCheck({ command: writeCommand("exit 1"), timeoutMs: 5_000 })).resolves.toBeNull();
    await expect(
      runClaudeUsageCheck({ command: writeCommand("echo '{\"result\":\"\"}'"), timeoutMs: 5_000 }),
    ).resolves.toBeNull();
    await expect(
      runClaudeUsageCheck({ command: writeCommand("echo 'not-json'"), timeoutMs: 5_000 }),
    ).resolves.toBeNull();
  });

  it("parses a successful usage command", async () => {
    const command = writeCommand(
      `echo '{"result":"Current session: 0% used. Current week (all models): 4% used"}'`,
    );
    const snapshot = await runClaudeUsageCheck({ command, timeoutMs: 5_000 });
    expect(snapshot?.sessionPercent).toBe(0);
    expect(snapshot?.weekPercent).toBe(4);
  });

  it("reuses a cached snapshot inside the minimum interval", async () => {
    resetClaudeUsageCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-claude-usage-"));
    const counter = path.join(dir, "count");
    const command = writeCommand(
      `echo x >> '${counter.replace(/'/g, `'\\''`)}'\necho '{"result":"Current session: 1% used"}'`,
    );
    const first = await getClaudeUsageSnapshot({ command, minIntervalMs: 60_000, timeoutMs: 5_000 });
    const second = await getClaudeUsageSnapshot({ command, minIntervalMs: 60_000, timeoutMs: 5_000 });
    expect(first?.sessionPercent).toBe(1);
    expect(second?.sessionPercent).toBe(1);
    expect(fs.readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(1);
    resetClaudeUsageCache();
  });
});

afterEach(() => {
  resetClaudeUsageCache();
});
