import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveActiveCredentialEnvPath } from "./credential-env.js";

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveActiveCredentialEnvPath", () => {
  it("uses the parent .env when the project directory has none", async () => {
    const root = await mkdtemp(join(tmpdir(), "pm-cred-"));
    dirs.push(root);
    const cwd = join(root, "projectmind-agent");
    await mkdir(cwd);
    const parentEnv = join(root, ".env");
    await writeFile(parentEnv, "IMEMORY_API_KEY=imgk_parent\nIMEMORY_WORKSPACE_ALLOWLIST=/a,/b\n");

    await expect(resolveActiveCredentialEnvPath(cwd, join(root, "node"))).resolves.toBe(parentEnv);
  });

  it("prefers the project .env over the parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pm-cred-"));
    dirs.push(root);
    const cwd = join(root, "app");
    await mkdir(cwd);
    const projectEnv = join(cwd, ".env");
    await writeFile(projectEnv, "IMEMORY_API_KEY=imk_local\n");
    await writeFile(join(root, ".env"), "IMEMORY_API_KEY=imgk_parent\n");

    await expect(resolveActiveCredentialEnvPath(cwd, join(root, "node"))).resolves.toBe(projectEnv);
  });

  it("falls back to the project .env when no key file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "pm-cred-"));
    dirs.push(root);
    const cwd = join(root, "app");
    await mkdir(cwd);

    await expect(resolveActiveCredentialEnvPath(cwd, join(root, "node"))).resolves.toBe(
      join(cwd, ".env"),
    );
  });
});
