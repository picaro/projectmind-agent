import { describe, expect, it, vi } from "vitest";
import {
  commitAndPushAfterTask,
  ensurePullRequest,
  shortCommitMessage,
  type GitPublishOptions,
} from "./git-publish.js";

describe("shortCommitMessage", () => {
  it("uses the first non-empty summary line", () => {
    expect(shortCommitMessage("Added Projects tab to bucket hub\n\nMore detail")).toBe(
      "Added Projects tab to bucket hub",
    );
  });

  it("strips markdown bold and list markers", () => {
    expect(shortCommitMessage("**Done**: fixed the bug")).toBe("Done: fixed the bug");
    expect(shortCommitMessage("- ship the feature")).toBe("ship the feature");
  });

  it("truncates long subjects", () => {
    const long = "x".repeat(100);
    const msg = shortCommitMessage(long);
    expect(msg.length).toBe(72);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("falls back to task id when summary empty", () => {
    expect(shortCommitMessage("", "3f512b37-2f1b-48da-975d-37a2321ddddc")).toBe(
      "Complete ProjectMind task 3f512b37",
    );
  });
});

describe("commitAndPushAfterTask", () => {
  function mockGit(map: Record<string, { code: number; stdout?: string; stderr?: string }>) {
    return vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      for (const [pattern, result] of Object.entries(map)) {
        if (key === pattern || key.startsWith(pattern)) {
          return {
            code: result.code,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
          };
        }
      }
      throw new Error(`unexpected git args: ${key}`);
    });
  }

  async function run(
    runGit: NonNullable<GitPublishOptions["runGit"]>,
    overrides: Partial<GitPublishOptions> = {},
  ) {
    const logs: string[] = [];
    const result = await commitAndPushAfterTask({
      cwd: "/tmp/repo",
      message: "Ship the feature",
      taskId: "abc-123",
      onLog: (m) => {
        logs.push(m);
      },
      enabled: true,
      push: true,
      runGit,
      ...overrides,
    });
    return { result, logs };
  }

  it("skips when disabled", async () => {
    const runGit = vi.fn();
    const { result } = await run(runGit, { enabled: false });
    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(true);
    expect(runGit).not.toHaveBeenCalled();
  });

  it("skips when not a git repo", async () => {
    const runGit = mockGit({
      "rev-parse --is-inside-work-tree": { code: 128, stderr: "not a git repo" },
    });
    const { result } = await run(runGit);
    expect(result.attempted).toBe(false);
    expect(result.detail).toMatch(/Not a git/);
  });

  it("skips when working tree is clean", async () => {
    const runGit = mockGit({
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "status --porcelain": { code: 0, stdout: "" },
    });
    const { result } = await run(runGit);
    expect(result.attempted).toBe(false);
    expect(result.detail).toMatch(/clean/);
  });

  it("commits and pushes dirty tree", async () => {
    const runGit = mockGit({
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "status --porcelain": { code: 0, stdout: " M src/a.ts\n" },
      "add -A": { code: 0 },
      "diff --cached --name-only": { code: 0, stdout: "src/a.ts\n" },
      "commit -m": { code: 0 },
      "rev-parse --short HEAD": { code: 0, stdout: "abc1234\n" },
      remote: { code: 0, stdout: "origin\n" },
      push: { code: 0 },
    });
    const { result, logs } = await run(runGit);
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.sha).toBe("abc1234");
    expect(result.detail).toMatch(/Committed and pushed/);
    expect(logs.some((l) => l.includes("Ship the feature"))).toBe(true);

    const commitCall = runGit.mock.calls.find((c) => c[1][0] === "commit");
    expect(commitCall?.[1]).toEqual(["commit", "-m", "Ship the feature"]);
  });

  it("retries push with -u origin HEAD when first push fails", async () => {
    let pushCount = 0;
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "rev-parse --is-inside-work-tree") {
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (key === "status --porcelain") {
        return { code: 0, stdout: " M a.ts\n", stderr: "" };
      }
      if (key === "add -A") return { code: 0, stdout: "", stderr: "" };
      if (key === "diff --cached --name-only") {
        return { code: 0, stdout: "a.ts\n", stderr: "" };
      }
      if (args[0] === "commit") return { code: 0, stdout: "", stderr: "" };
      if (key === "rev-parse --short HEAD") {
        return { code: 0, stdout: "deadbee\n", stderr: "" };
      }
      if (key === "remote") return { code: 0, stdout: "origin\n", stderr: "" };
      if (args[0] === "push" && args.length === 1) {
        pushCount += 1;
        return { code: 128, stdout: "", stderr: "no upstream" };
      }
      if (key === "push -u origin HEAD") {
        pushCount += 1;
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected: ${key}`);
    });

    const { result } = await run(runGit);
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(true);
    expect(pushCount).toBe(2);
  });

  it("commits locally and says so when there is no remote", async () => {
    // A repo-less project's managed workspace is a bare `git init`.
    const runGit = mockGit({
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "status --porcelain": { code: 0, stdout: " M a.ts\n" },
      "add -A": { code: 0 },
      "diff --cached --name-only": { code: 0, stdout: "a.ts\n" },
      "commit -m": { code: 0 },
      "rev-parse --short HEAD": { code: 0, stdout: "abc1234\n" },
      remote: { code: 0, stdout: "" },
    });

    const { result, logs } = await run(runGit);

    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.detail).toMatch(/no remote configured/);
    expect(logs.some((l) => l.includes("no remote configured"))).toBe(true);
    expect(runGit.mock.calls.some((c) => c[1][0] === "push")).toBe(false);
  });

  it("refuses to commit sensitive staged paths", async () => {
    const runGit = mockGit({
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "status --porcelain": { code: 0, stdout: "?? .env\n" },
      "add -A": { code: 0 },
      "diff --cached --name-only": { code: 0, stdout: ".env\n" },
      "reset HEAD": { code: 0 },
    });
    const { result } = await run(runGit);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/sensitive/);
  });

  it("can commit without push when push disabled", async () => {
    const runGit = mockGit({
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "status --porcelain": { code: 0, stdout: " M a.ts\n" },
      "add -A": { code: 0 },
      "diff --cached --name-only": { code: 0, stdout: "a.ts\n" },
      "commit -m": { code: 0 },
      "rev-parse --short HEAD": { code: 0, stdout: "cafe\n" },
    });
    const { result } = await run(runGit, { push: false });
    expect(result.ok).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(false);
    expect(runGit.mock.calls.some((c) => c[1][0] === "push")).toBe(false);
  });
});

describe("ensurePullRequest", () => {
  it("returns an existing PR URL without creating", async () => {
    const runGh = vi.fn(async (_cwd: string, args: string[]) => {
      if (args.join(" ") === "pr view --json url -q .url") {
        return { code: 0, stdout: "https://github.com/acme/r/pull/7\n", stderr: "" };
      }
      throw new Error(`unexpected: ${args.join(" ")}`);
    });
    const logs: string[] = [];
    const result = await ensurePullRequest({
      cwd: "/tmp/repo",
      baseBranch: "main",
      title: "Ship it",
      onLog: (m) => logs.push(m),
      runGh,
    });
    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/r/pull/7");
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it("creates a PR when none exists", async () => {
    const runGh = vi.fn(async (_cwd: string, args: string[]) => {
      const key = args.join(" ");
      if (key === "pr view --json url -q .url") {
        return { code: 1, stdout: "", stderr: "no pr" };
      }
      if (key.startsWith("pr create")) {
        return { code: 0, stdout: "https://github.com/acme/r/pull/8\n", stderr: "" };
      }
      throw new Error(`unexpected: ${key}`);
    });
    const result = await ensurePullRequest({
      cwd: "/tmp/repo",
      baseBranch: "main",
      title: "Ship it",
      body: "Details",
      onLog: async () => {},
      runGh,
    });
    expect(result.ok).toBe(true);
    expect(result.prUrl).toBe("https://github.com/acme/r/pull/8");
  });
});
