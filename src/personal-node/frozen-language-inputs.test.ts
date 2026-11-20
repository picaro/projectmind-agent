import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { prepareAppBuild, removeBuildWorkspace } from "./git-build";

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "frozen-language-inputs-"));
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(root, name), value);
  return {
    root,
    build: (buildPack: "railpack" | "static" = "railpack") =>
      prepareAppBuild({
        commandId: "660e8400-e29b-41d4-a716-446655440095",
        checkoutDir: root,
        target: { platform: "linux/amd64", runtimePort: 3000 },
        spec: {
          repositoryUrl: "https://fixture.example.test/app",
          ref: "main",
          buildPack,
          baseDirectory: ".",
        },
      }),
  };
}
it.each([
  [{ "composer.json": "{}" }, /composer.lock/],
  [{ "composer.json": "{}", "composer.lock": "PRIVATE-invalid-json" }, /valid composer/],
  [{ Gemfile: "source 'https://rubygems.org'" }, /Gemfile.lock/],
  [{ Gemfile: "fixture", "Gemfile.lock": "BUNDLED WITH\n  latest\n" }, /exact BUNDLED WITH/],
  [{ "Cargo.toml": "[package]" }, /Cargo.lock/],
  [
    { "Cargo.toml": "[package]", "Cargo.lock": "version = 4", "rust-toolchain": "stable" },
    /exact or dated/,
  ],
  [
    {
      "Cargo.toml": "[package]",
      "Cargo.lock": "version = 4",
      "rust-toolchain.toml": '[toolchain]\nchannel = "nightly"',
    },
    /exact or dated/,
  ],
  [{ "go.mod": "module fixture\n\ngo 1.23\ntoolchain go1.27.3\n" }, /pinned base SDK/],
])("rejects unfrozen generated input before writing the recipe: %j", async (files, error) => {
  const f = await fixture(files as Record<string, string>);
  try {
    await expect(f.build()).rejects.toThrow(error);
    await expect(stat(path.join(f.root, "pm.Dockerfile"))).rejects.toThrow();
    try {
      await f.build();
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE");
    }
  } finally {
    await removeBuildWorkspace(f.root);
  }
});

it.each(["empty", "symlink", "oversized"])("rejects %s lock input", async (kind) => {
  const f = await fixture({ "composer.json": "{}" });
  try {
    const lock = path.join(f.root, "composer.lock");
    if (kind === "symlink") await symlink(path.join(f.root, "composer.json"), lock);
    else await writeFile(lock, kind === "empty" ? "" : "x".repeat(16777217));
    await expect(f.build()).rejects.toThrow(/regular composer.lock/);
    await expect(stat(path.join(f.root, "pm.Dockerfile"))).rejects.toThrow();
  } finally {
    await removeBuildWorkspace(f.root);
  }
});

it.each([
  [
    { "go.mod": "module fixture\n\ngo 1.23\n" },
    ["ENV GOTOOLCHAIN=local", "go build -mod=readonly -trimpath"],
  ],
  [
    { "composer.json": "{}", "composer.lock": '{"packages":[]}' },
    ["composer install --no-dev --no-interaction"],
  ],
  [
    { Gemfile: "fixture", "Gemfile.lock": "BUNDLED WITH\n  2.5.22\n" },
    [
      "BUNDLE_FROZEN=true",
      "gem install bundler --version 2.5.22",
      "bundle _2.5.22_ install",
      '["bundle","_2.5.22_","exec"',
    ],
  ],
  [
    {
      "Cargo.toml": "[package]",
      "Cargo.lock": "version = 4",
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.85.0"',
    },
    ["cargo build --release --locked"],
  ],
])("keeps declared frozen install inputs for %j", async (files, fragments) => {
  const f = await fixture(files as Record<string, string>);
  try {
    await f.build();
    const recipe = await readFile(path.join(f.root, "pm.Dockerfile"), "utf8");
    for (const fragment of fragments as string[]) expect(recipe).toContain(fragment);
  } finally {
    await removeBuildWorkspace(f.root);
  }
});

it("preserves explicit Dockerfile and explicitly selected static precedence", async () => {
  const f = await fixture({ Gemfile: "fixture", Dockerfile: "FROM fixture.example.test/custom\n" });
  try {
    const result = await f.build();
    expect(result.buildSpec.builder.actualStrategy).toBe("repository_dockerfile");
    expect(await readFile(path.join(f.root, "Dockerfile"), "utf8")).toBe(
      "FROM fixture.example.test/custom\n",
    );
    await expect(stat(path.join(f.root, "pm.Dockerfile"))).rejects.toThrow();
  } finally {
    await removeBuildWorkspace(f.root);
  }
  const staticApp = await fixture({ Gemfile: "fixture", "index.html": "static" });
  try {
    await staticApp.build("static");
    expect(await readFile(path.join(staticApp.root, "pm.Dockerfile"), "utf8")).toContain("nginx");
  } finally {
    await removeBuildWorkspace(staticApp.root);
  }
});
