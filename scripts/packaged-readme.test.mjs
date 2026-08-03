import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_MCP_URL,
  buildPackagedReadme,
  writeClearQuarantineHelper,
  writePackagedReadme,
} from "./packaged-readme.mjs";

const TARGETS = [
  {
    id: "macos-arm64",
    label: "macOS (Apple Silicon)",
    os: "macos",
    arch: "arm64",
  },
  {
    id: "macos-x64",
    label: "macOS (Intel)",
    os: "macos",
    arch: "x64",
  },
  {
    id: "windows-x64",
    label: "Windows (x64)",
    os: "windows",
    arch: "x64",
  },
  {
    id: "ubuntu-x64",
    label: "Ubuntu (x64)",
    os: "ubuntu",
    arch: "x64",
  },
  {
    id: "nodejs",
    label: "Node.js (cross-platform)",
    os: "nodejs",
    arch: "any",
  },
];

describe("packaged-readme", () => {
  it("builds a distinct README per platform with how-to-run steps", () => {
    const bodies = Object.fromEntries(TARGETS.map((t) => [t.id, buildPackagedReadme(t, "0.2.0")]));

    expect(bodies["macos-arm64"]).toContain("How to run (macOS)");
    expect(bodies["macos-arm64"]).toContain("./imemory-agent");
    expect(bodies["macos-arm64"]).toContain("xattr -dr com.apple.quarantine");
    expect(bodies["macos-arm64"]).toContain("Apple Silicon");
    expect(bodies["macos-arm64"]).toContain(PRODUCTION_MCP_URL);

    expect(bodies["macos-x64"]).toContain("How to run (macOS)");
    expect(bodies["macos-x64"]).toContain("Intel");
    expect(bodies["macos-x64"]).not.toContain("Apple Silicon");

    expect(bodies["windows-x64"]).toContain("How to run (Windows)");
    expect(bodies["windows-x64"]).toContain(".\\imemory-agent.exe");
    expect(bodies["windows-x64"]).toContain("SmartScreen");
    expect(bodies["windows-x64"]).not.toContain("./imemory-agent");

    expect(bodies["ubuntu-x64"]).toContain("How to run (Ubuntu / Linux)");
    expect(bodies["ubuntu-x64"]).toContain("chmod +x ./imemory-agent");
    expect(bodies["ubuntu-x64"]).toContain("glibc");
    expect(bodies["ubuntu-x64"]).not.toContain("SmartScreen");
    expect(bodies["ubuntu-x64"]).not.toContain("Gatekeeper");

    expect(bodies.nodejs).toContain("How to run (Node.js)");
    expect(bodies.nodejs).toContain("npm install");
    expect(bodies.nodejs).toContain("npm start");
    expect(bodies.nodejs).toContain("not bare `npm run`");
    expect(bodies.nodejs).toContain("start.command");
    expect(bodies.nodejs).toContain("Node.js 22.13+");
    expect(bodies.nodejs).toContain("auto-updates");
    expect(bodies.nodejs).not.toContain("./imemory-agent");
    expect(bodies.nodejs).not.toContain("Node.js 18+");

    expect(bodies["macos-arm64"]).toContain("Auto-updates from ProjectMind");
    expect(bodies["windows-x64"]).toContain("Auto-updates from ProjectMind");
    expect(bodies["ubuntu-x64"]).toContain("Auto-updates from ProjectMind");

    // Each platform body should differ from the others (not a shared template dump).
    const unique = new Set(Object.values(bodies));
    expect(unique.size).toBe(TARGETS.length);
  });

  it("writes README.txt and macOS quarantine helper into the stage folder", async () => {
    const stage = await mkdtemp(join(tmpdir(), "imemory-packaged-readme-"));
    try {
      const body = await writePackagedReadme(stage, TARGETS[0], "0.2.0", {
        writeClearQuarantine: writeClearQuarantineHelper,
      });
      const onDisk = await readFile(join(stage, "README.txt"), "utf8");
      expect(onDisk).toBe(body);
      expect(onDisk).toContain("How to run (macOS)");
      const helper = await readFile(join(stage, "clear-quarantine.command"), "utf8");
      expect(helper).toContain("xattr -dr com.apple.quarantine");
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("writes Windows README without a quarantine helper", async () => {
    const stage = await mkdtemp(join(tmpdir(), "imemory-packaged-readme-win-"));
    try {
      await writePackagedReadme(stage, TARGETS[2], "0.2.0", {
        writeClearQuarantine: writeClearQuarantineHelper,
      });
      const onDisk = await readFile(join(stage, "README.txt"), "utf8");
      expect(onDisk).toContain("How to run (Windows)");
      await expect(readFile(join(stage, "clear-quarantine.command"), "utf8")).rejects.toThrow();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
});
