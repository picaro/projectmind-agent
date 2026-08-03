import { beforeEach, describe, expect, it, vi } from "vitest";

const callToolJson = vi.fn();

vi.mock("./mcp-client.js", () => ({
  callToolJson: (...args: unknown[]) => callToolJson(...args),
}));

import { assertCwdMatchesJobProject } from "./jobs.js";

describe("assertCwdMatchesJobProject", () => {
  beforeEach(() => {
    callToolJson.mockReset();
  });

  it("allows when find returns the job project", async () => {
    callToolJson.mockResolvedValue({
      projectId: "proj-a",
      slug: "alpha",
      name: "Alpha",
    });
    await expect(
      assertCwdMatchesJobProject({} as never, {
        project_id: "proj-a",
        local_directory: "/Users/me/alpha",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("rejects when cwd is linked to a different project", async () => {
    callToolJson.mockResolvedValue({
      projectId: "proj-imemory",
      slug: "imemory",
      name: "IMemory",
    });
    const result = await assertCwdMatchesJobProject({} as never, {
      project_id: "proj-mypeople",
      local_directory: "/Users/me/imemory",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/linked to project IMemory/);
      expect(result.reason).toMatch(/proj-mypeople/);
    }
  });

  it("allows when no project claims the path", async () => {
    callToolJson.mockRejectedValue(new Error("Project not found"));
    await expect(
      assertCwdMatchesJobProject({} as never, {
        project_id: "proj-a",
        local_directory: "/Users/me/orphan",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("continues with warning when lookup fails for other reasons", async () => {
    callToolJson.mockRejectedValue(new Error("network down"));
    const result = await assertCwdMatchesJobProject({} as never, {
      project_id: "proj-a",
      local_directory: "/Users/me/alpha",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toMatch(/network down/);
    }
  });
});
