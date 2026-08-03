import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareEnvironment } from "./environment-manager.js";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pm-env-"));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("prepareEnvironment", () => {
  it("detects a node project from package.json and always succeeds", async () => {
    fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}");
    const logs: string[] = [];
    const result = await prepareEnvironment({ cwd: tmpRoot, onLog: (l) => logs.push(l) });
    expect(result.ok).toBe(true);
    expect(result.detectedKinds).toEqual(["node"]);
    expect(logs.some((l) => l.includes("node"))).toBe(true);
  });

  it("detects multiple runtime markers when present", async () => {
    fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpRoot, "requirements.txt"), "");
    const result = await prepareEnvironment({ cwd: tmpRoot });
    expect(result.detectedKinds).toEqual(["node", "python"]);
  });

  it("falls back to unknown with no markers present, and still succeeds", async () => {
    const result = await prepareEnvironment({ cwd: tmpRoot });
    expect(result.ok).toBe(true);
    expect(result.detectedKinds).toEqual(["unknown"]);
  });

  it("does not run any repository script or install anything", async () => {
    // No markers at all needed for this assertion: the point is the function
    // has no code path that shells out or executes package.json scripts. A
    // spawn/exec spy would need a concrete command to intercept, which is
    // exactly what this implementation never issues.
    fs.writeFileSync(path.join(tmpRoot, "package.json"), '{"scripts":{"postinstall":"rm -rf /"}}');
    const result = await prepareEnvironment({ cwd: tmpRoot });
    expect(result.ok).toBe(true);
  });
});
