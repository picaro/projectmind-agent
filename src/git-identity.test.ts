import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit, setActiveGitIdentity } from "./git-publish.js";

const KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

afterEach(() => {
  setActiveGitIdentity(null);
});

describe("setActiveGitIdentity", () => {
  it("sets author and committer env, then restores the machine's values", () => {
    process.env.GIT_AUTHOR_NAME = "Machine";
    delete process.env.GIT_AUTHOR_EMAIL;

    setActiveGitIdentity({
      name: "Project Owner",
      email: "1+owner@users.noreply.github.com",
    });
    expect(KEYS.map((k) => process.env[k])).toEqual([
      "Project Owner",
      "1+owner@users.noreply.github.com",
      "Project Owner",
      "1+owner@users.noreply.github.com",
    ]);

    setActiveGitIdentity(null);
    expect(process.env.GIT_AUTHOR_NAME).toBe("Machine");
    expect(process.env.GIT_AUTHOR_EMAIL).toBeUndefined();
    delete process.env.GIT_AUTHOR_NAME;
  });

  it("ignores an empty identity", () => {
    setActiveGitIdentity({ name: " ", email: "" });
    expect(process.env.GIT_COMMITTER_NAME).toBeUndefined();
  });

  it("makes commits run through runGit use the identity over repo config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-identity-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      execFileSync("git", ["config", "user.name", "Requester"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "requester@example.com"], {
        cwd: dir,
      });
      writeFileSync(join(dir, "a.txt"), "one\n");
      setActiveGitIdentity({
        name: "Project Owner",
        email: "owner@example.com",
      });
      await runGit(dir, ["add", "-A"]);
      const commit = await runGit(dir, [
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "x",
      ]);
      expect(commit.code).toBe(0);
      const log = await runGit(dir, [
        "log",
        "-1",
        "--format=%an <%ae> | %cn <%ce>",
      ]);
      expect(log.stdout.trim()).toBe(
        "Project Owner <owner@example.com> | Project Owner <owner@example.com>",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
