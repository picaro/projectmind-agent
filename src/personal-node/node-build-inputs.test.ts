import { mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareAppBuild, removeBuildWorkspace } from "./git-build";

async function prepare(manifest: unknown, locks: string[] = [], dockerfile = false) {
  const root = await mkdtemp(path.join(tmpdir(), "node-lock-inputs-"));
  await writeFile(
    path.join(root, "package.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  for (const lock of locks) await writeFile(path.join(root, lock), "fixture-lock");
  if (dockerfile)
    await writeFile(path.join(root, "Dockerfile"), "FROM fixture.example.test/owned\n");
  return {
    root,
    build: () =>
      prepareAppBuild({
        commandId: "660e8400-e29b-41d4-a716-446655440095",
        checkoutDir: root,
        target: { platform: "linux/amd64", runtimePort: 3000 },
        spec: {
          repositoryUrl: "https://fixture.example.test/app",
          ref: "main",
          buildPack: "railpack",
          baseDirectory: ".",
        },
      }),
  };
}
it.each([
  [{ dependencies: { example: "*" } }, [], /lockfile/],
  [{ devDependencies: { example: "*" } }, [], /lockfile/],
  [{ optionalDependencies: { example: "*" } }, [], /lockfile/],
  [{ peerDependencies: { example: "*" } }, [], /lockfile/],
  [{ workspaces: ["apps/*"] }, [], /lockfile/],
  [{}, ["pnpm-lock.yaml"], /packageManager/],
  [{ packageManager: "yarn@latest" }, ["yarn.lock"], /exact/],
  [{ packageManager: "pnpm@^10.17.1" }, ["pnpm-lock.yaml"], /exact/],
  [{ packageManager: "yarn@1.22.22" }, ["pnpm-lock.yaml"], /match/],
  [{ packageManager: "pnpm@10.17.1" }, ["pnpm-lock.yaml", "yarn.lock"], /multiple/],
  ["{secret_manifest_value", [], /valid package.json/],
  [{ dependencies: "secret_manifest_value" }, [], /must be objects/],
  [{ packageManager: "npm@latest" }, [], /exact/],
  [{ devEngines: { packageManager: { name: "yarn", version: "*" } } }, [], /packageManager/],
] as const)(
  "rejects ambiguous or unlocked Node inputs %# before writing a recipe",
  async (manifest, locks, message) => {
    const fixture = await prepare(manifest, [...locks]);
    try {
      await expect(fixture.build()).rejects.toThrow(message);
      await expect(fixture.build()).rejects.not.toThrow(/secret_manifest_value/);
      await expect(stat(path.join(fixture.root, "pm.Dockerfile"))).rejects.toThrow();
    } finally {
      await removeBuildWorkspace(fixture.root);
    }
  },
);
it.each([
  [{}, [], "npm install", '["npm","start"]'],
  [{ dependencies: { example: "1.0.0" } }, ["package-lock.json"], "npm ci", '["npm","start"]'],
  [{}, ["npm-shrinkwrap.json"], "npm ci", '["npm","start"]'],
  [
    { packageManager: "npm@10.9.3" },
    ["package-lock.json"],
    "corepack npm@10.9.3 ci",
    '["corepack","npm@10.9.3","start"]',
  ],
  [
    { packageManager: "pnpm@10.17.1" },
    ["pnpm-lock.yaml"],
    "corepack pnpm@10.17.1 install --frozen-lockfile",
    '["corepack","pnpm@10.17.1","start"]',
  ],
  [
    { packageManager: "yarn@1.22.22" },
    ["yarn.lock"],
    "corepack yarn@1.22.22 install --frozen-lockfile",
    '["corepack","yarn@1.22.22","start"]',
  ],
  [
    { packageManager: "yarn@4.11.0" },
    ["yarn.lock"],
    "corepack yarn@4.11.0 install --immutable",
    '["corepack","yarn@4.11.0","start"]',
  ],
] as const)(
  "locks install and start manager selection %#",
  async (manifest, locks, install, start) => {
    const fixture = await prepare(manifest, [...locks]);
    try {
      await fixture.build();
      const recipe = await readFile(path.join(fixture.root, "pm.Dockerfile"), "utf8");
      expect(recipe).toContain(install);
      expect(recipe).toContain(`CMD ${start}`);
    } finally {
      await removeBuildWorkspace(fixture.root);
    }
  },
);
it("preserves an explicit Dockerfile even with an invalid manifest", async () => {
  const fixture = await prepare("{secret_manifest_value", [], true);
  try {
    expect((await fixture.build()).buildSpec.builder.actualStrategy).toBe("repository_dockerfile");
  } finally {
    await removeBuildWorkspace(fixture.root);
  }
});
it.each(["empty lock", "symlink lock", "symlink manifest"])("rejects %s", async (kind) => {
  const fixture = await prepare({ dependencies: { example: "1.0.0" } }, ["package-lock.json"]);
  try {
    const lock = path.join(fixture.root, "package-lock.json");
    if (kind === "empty lock") await writeFile(lock, "");
    else {
      const target = path.join(fixture.root, "outside-input");
      await writeFile(target, "{}");
      const input = kind === "symlink lock" ? lock : path.join(fixture.root, "package.json");
      await unlink(input);
      await symlink(target, input);
    }
    await expect(fixture.build()).rejects.toThrow(/regular/);
    await expect(stat(path.join(fixture.root, "pm.Dockerfile"))).rejects.toThrow();
  } finally {
    await removeBuildWorkspace(fixture.root);
  }
});
