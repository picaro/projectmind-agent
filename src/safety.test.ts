import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafeWorkspace,
  ensureAllowlistedWorkspace,
  parseAllowlist,
  resolveUnderCwd,
} from "./safety.js";

describe("parseAllowlist", () => {
  it("splits and resolves roots", () => {
    const roots = parseAllowlist(" /tmp/a , /tmp/b ");
    expect(roots).toEqual([path.resolve("/tmp/a"), path.resolve("/tmp/b")]);
  });

  it("returns empty for blank", () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("  ")).toEqual([]);
  });
});

describe("assertSafeWorkspace", () => {
  it("rejects empty allowlist", () => {
    const result = assertSafeWorkspace("/tmp", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ALLOWLIST/);
  });

  it("accepts a directory under allowlist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-allow-"));
    const child = path.join(root, "repo");
    fs.mkdirSync(child);
    const result = assertSafeWorkspace(child, [root]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cwd).toBe(fs.realpathSync(child));
  });

  it("rejects path outside allowlist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-allow-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-other-"));
    const result = assertSafeWorkspace(other, [root]);
    expect(result.ok).toBe(false);
  });

  it("rejects symlink escape outside allowlist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-allow-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-secret-"));
    const link = path.join(root, "escape");
    fs.symlinkSync(outside, link);
    const result = assertSafeWorkspace(link, [root]);
    // realpath resolves into outside; must be rejected
    expect(result.ok).toBe(false);
  });
});

describe("resolveUnderCwd", () => {
  it("allows relative paths inside cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-cwd-"));
    expect(resolveUnderCwd(root, "src/a.ts")).toBe(path.join(fs.realpathSync(root), "src/a.ts"));
  });

  it("rejects .. escape", () => {
    expect(resolveUnderCwd("/tmp/ws", "../secret")).toBeNull();
  });

  it("rejects symlink file escape outside cwd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-cwd-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "imemory-out-"));
    const secret = path.join(outside, "secret.txt");
    fs.writeFileSync(secret, "nope");
    const link = path.join(root, "leak.txt");
    fs.symlinkSync(secret, link);
    expect(resolveUnderCwd(root, "leak.txt")).toBeNull();
  });
});

describe("ensureAllowlistedWorkspace", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-allow-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates a directory that does not exist yet inside the allowlist", () => {
    const target = path.join(root, "projects", "demo");
    expect(fs.existsSync(target)).toBe(false);

    const result = ensureAllowlistedWorkspace(target, [root]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(fs.realpathSync(result.path)).toBe(fs.realpathSync(target));
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("reuses a directory that already exists", () => {
    const target = path.join(root, "existing");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "keep.txt"), "keep");

    const result = ensureAllowlistedWorkspace(target, [root]);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  it("refuses a path outside the allowlist, and creates nothing", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pm-outside-"));
    const target = path.join(outside, "demo");

    const result = ensureAllowlistedWorkspace(target, [root]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside this agent's allowlist/);
    expect(fs.existsSync(target)).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a traversal that would escape the allowlist", () => {
    const target = path.join(root, "..", "escape-me");

    const result = ensureAllowlistedWorkspace(target, [root]);

    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.resolve(target))).toBe(false);
  });

  it("refuses when no allowlist is configured", () => {
    const result = ensureAllowlistedWorkspace(path.join(root, "demo"), []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/IMEMORY_WORKSPACE_ALLOWLIST/);
  });

  it("refuses a path that exists but is a file", () => {
    const target = path.join(root, "a-file");
    fs.writeFileSync(target, "not a directory");

    const result = ensureAllowlistedWorkspace(target, [root]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a directory/);
  });

  it("refuses a relative path", () => {
    const result = ensureAllowlistedWorkspace("relative/dir", [root]);
    expect(result.ok).toBe(false);
  });
});
