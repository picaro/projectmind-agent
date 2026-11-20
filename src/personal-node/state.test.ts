import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.js";
import {
  acknowledgeCompletedCommand,
  readState,
  rememberCompletedCommand,
  stateFilePath,
  writeState,
} from "./state.js";

describe("personal node state", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes the device token with mode 0600", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-state-"));
    const token = "pnd_test_token_value";
    await writeState(dir, {
      sessionId: "550e8400-e29b-41d4-a716-446655440011",
      nodeId: "550e8400-e29b-41d4-a716-446655440010",
      deviceToken: token,
      server: "http://127.0.0.1:8080/",
      completedCommandIds: ["cmd-1"],
    });
    const file = await stat(stateFilePath(dir));
    const directory = await stat(dir);
    expect(file.mode & 0o777).toBe(0o600);
    expect(directory.mode & 0o777).toBe(0o700);
    const loaded = await readState(dir);
    expect(loaded?.completedCommandIds).toEqual(["cmd-1"]);
    expect(loaded?.deviceToken).toBe(token);
    expect(loaded?.server).toBe("http://127.0.0.1:8080");
  });

  it("reads a state file written before the server origin was stored", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-state-"));
    await writeFile(
      stateFilePath(dir),
      JSON.stringify({
        sessionId: "550e8400-e29b-41d4-a716-446655440011",
        nodeId: "550e8400-e29b-41d4-a716-446655440010",
        deviceToken: "pnd_test_token_value",
        completedCommandIds: [],
      }),
      "utf8",
    );
    const loaded = await readState(dir);
    expect(loaded?.server).toBeUndefined();
    expect(loaded?.nodeId).toBe("550e8400-e29b-41d4-a716-446655440010");
  });

  it("redacts the device token and the pairing code", () => {
    const text = redactSecrets("exchange failed for ABCD-EFGH with pnd_test_token_value", [
      "ABCD-EFGH",
      "pnd_test_token_value",
    ]);
    expect(text).not.toContain("ABCD-EFGH");
    expect(text).not.toContain("pnd_test_token_value");
    expect(redactSecrets("see https://apps.example.test/x")).not.toMatch(/https?:\/\//);
  });

  it("persists completion outcomes without extra fields and clears only delivered receipts", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-state-"));
    await writeState(dir, {
      sessionId: "session",
      nodeId: "node",
      deviceToken: "pnd_test",
      completedCommandIds: [],
    });
    await rememberCompletedCommand(dir, "one", "applied");
    await rememberCompletedCommand(dir, "one", "failed");
    await rememberCompletedCommand(dir, "two", "failed");
    expect((await readState(dir))?.pendingCommandCompletions).toEqual([
      { commandId: "one", outcome: "applied" },
      { commandId: "two", outcome: "failed" },
    ]);
    await acknowledgeCompletedCommand(dir, "one");
    expect((await readState(dir))?.pendingCommandCompletions).toEqual([
      { commandId: "two", outcome: "failed" },
    ]);
    expect((await readState(dir))?.completedCommandIds).toEqual(["one", "two"]);
    expect((await stat(stateFilePath(dir))).mode & 0o777).toBe(0o600);
  });

  it("fails closed on malformed or overfull outboxes instead of discarding outcomes", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-state-"));
    for (const pendingCommandCompletions of [
      [{ commandId: "one", outcome: "unknown" }],
      [
        { commandId: "one", outcome: "applied" },
        { commandId: "one", outcome: "failed" },
      ],
      Array.from({ length: 65 }, (_, i) => ({ commandId: `cmd-${i}`, outcome: "applied" })),
    ]) {
      await writeFile(
        stateFilePath(dir),
        JSON.stringify({
          sessionId: "session",
          nodeId: "node",
          deviceToken: "pnd_test",
          completedCommandIds: [],
          pendingCommandCompletions,
        }),
      );
      await expect(readState(dir)).rejects.toThrow("completion outbox is invalid");
    }
  });
});
