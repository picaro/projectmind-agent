import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafeDockerArgs } from "./docker.js";
import {
  appDockerfile,
  dockerfileBuildBindings,
  dockerFailureText,
  fetchDockerfile,
  formatBuildProvenance,
  prepareAppBuild,
  prepareFetchWorkspace,
  removeBuildWorkspace,
} from "./git-build.js";

describe("generated Dockerfiles", () => {
  it("uses immutable registry inputs in every managed fetch/build stage", () => {
    const recipes = [fetchDockerfile(false), fetchDockerfile(true)];
    for (const marker of [
      "package.json",
      "index.html",
      "go.mod",
      "composer.json",
      "Gemfile",
      "Cargo.toml",
    ]) {
      const chosen = appDockerfile("railpack", [marker]);
      expect(chosen.kind).toBe("generate");
      if (chosen.kind === "generate") recipes.push(chosen.contents);
    }
    const inputs = recipes.flatMap((recipe) =>
      [...recipe.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]!),
    );
    expect(new Set(inputs).size).toBe(9);
    for (const input of inputs)
      expect(input).toMatch(
        /^public\.ecr\.aws\/docker\/library\/(?:[a-z]+|buildpack-deps):[a-z0-9.-]+@sha256:[a-f0-9]{64}$/,
      );
  });
  it("uses a pinned complete Git tool image without package-manager downloads during source fetch", () => {
    for (const recipe of [fetchDockerfile(false), fetchDockerfile(true)]) {
      expect(recipe).toMatch(
        /^FROM public\.ecr\.aws\/docker\/library\/buildpack-deps:bookworm-scm@sha256:[a-f0-9]{64}\n/,
      );
      expect(recipe).not.toMatch(/\b(?:apt-get|apk|yum|dnf)\b/);
      expect(recipe).toContain('fetch --depth 1 origin "$GIT_REF"');
    }
  });
  it("refreshes a symbolic private ref for each request while preserving same-command retries", async () => {
    const firstId = "660e8400-e29b-41d4-a716-446655440096";
    const secondId = "660e8400-e29b-41d4-a716-446655440097";
    const spec = {
      repositoryUrl: "https://github.com/acme/private",
      ref: "main",
      buildPack: "railpack" as const,
      baseDirectory: ".",
    };
    const token = "fixture-private-token-not-an-argument";
    const workspaces = [];
    try {
      for (const commandId of [firstId, firstId, secondId]) {
        const workspace = await prepareFetchWorkspace({
          commandId,
          spec,
          credential: { username: "x-access-token", token },
        });
        workspaces.push(workspace);
        expect(workspace.buildArgs).toContain(`FETCH_REQUEST_ID=${commandId}`);
        expect(workspace.buildArgs.join(" ")).not.toContain(token);
        expect(await readFile(workspace.credentialFile!, "utf8")).toBe(
          `x-access-token\n${token}\n`,
        );
        expect((await stat(workspace.credentialFile!)).mode & 0o777).toBe(0o600);
        expect(() => assertSafeDockerArgs(workspace.buildArgs)).not.toThrow();
      }
      expect(workspaces[0]!.buildArgs).toEqual(workspaces[1]!.buildArgs);
      expect(workspaces[2]!.buildArgs).not.toContain(`FETCH_REQUEST_ID=${firstId}`);
      const recipe = fetchDockerfile(true);
      expect(recipe).toContain('test -n "$FETCH_REQUEST_ID"');
      expect(recipe.indexOf("ARG FETCH_REQUEST_ID")).toBeGreaterThan(recipe.indexOf("FROM "));
    } finally {
      for (const workspace of workspaces) await removeBuildWorkspace(workspace.root);
    }
  });
  it("uses a generated Node Dockerfile for a requested nixpacks build without downloading a builder", () => {
    const generated = appDockerfile("nixpacks", ["package.json", "pnpm-lock.yaml"]);
    expect(generated.kind).toBe("generate");
    if (generated.kind !== "generate") return;
    expect(generated.contents).toContain("pnpm install --frozen-lockfile");
    expect(generated.contents).toContain("public.ecr.aws/docker/library/node:");
    expect(generated.contents).not.toMatch(/curl\s*\|/);
    expect(generated.contents).not.toContain("bash");
    expect(fetchDockerfile(false)).not.toContain("credential.helper");
    expect(fetchDockerfile(false)).not.toContain("blob:none");
    expect(fetchDockerfile(false)).toContain('fetch --depth 1 origin "$GIT_REF"');
    const privateFetch = fetchDockerfile(true);
    expect(privateFetch).toContain("--mount=type=secret,id=gitcred");
    expect(privateFetch).not.toContain("blob:none");
    expect(privateFetch).not.toMatch(/curl\s*\|/);
    expect(privateFetch).toMatch(/credential\.helper=.*checkout --detach FETCH_HEAD/s);
    const failure = dockerFailureText(
      128,
      [
        "Updating files: 100% (8925/8925), done.",
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
        "fatal: could not fetch abc from promisor remote",
      ].join("\n"),
    );
    expect(failure).toContain("could not read Username");
    expect(failure).toContain("promisor remote");
    expect(failure).not.toContain("Updating files");
  });

  it("uses an existing Dockerfile when that is the stored build pack", () => {
    expect(appDockerfile("dockerfile", ["Dockerfile", "package.json"])).toEqual({
      kind: "existing",
      fileName: "Dockerfile",
    });
    expect(appDockerfile("dockerfile", ["package.json"]).kind).toBe("missing");
  });

  it("prefers the repository's Dockerfile over a generated one for nixpacks", () => {
    // A generated node:22 image has no private-registry token and fails pnpm install.
    const files = ["Dockerfile", "package.json", "pnpm-lock.yaml", ".npmrc"];
    expect(appDockerfile("nixpacks", files)).toEqual({ kind: "existing", fileName: "Dockerfile" });
    expect(appDockerfile("railpack", files)).toEqual({ kind: "existing", fileName: "Dockerfile" });
    expect(appDockerfile("static", ["Dockerfile", "index.html"])).toEqual({
      kind: "existing",
      fileName: "Dockerfile",
    });
  });

  it.each(["nixpacks", "railpack"] as const)(
    "rejects unknown %s stacks instead of guessing Node",
    (pack) => {
      for (const files of [
        [],
        ["pom.xml"],
        ["build.gradle.kts"],
        ["README.md"],
        ["apps/web/package.json"],
        ["nested/Dockerfile"],
      ]) {
        const chosen = appDockerfile(pack, files);
        expect(chosen.kind).toBe("missing");
        if (chosen.kind === "missing") expect(chosen.message).toMatch(/Dockerfile.*base directory/);
      }
    },
  );

  it.each([
    ["package.json", "node:"],
    ["go.mod", "golang:"],
    ["composer.json", "php:"],
    ["Gemfile", "ruby:"],
    ["Cargo.toml", "rust:"],
    ["index.html", "nginx:"],
  ])("keeps the existing supported generator for %s", (marker, image) => {
    const chosen = appDockerfile("railpack", [marker]);
    expect(chosen.kind).toBe("generate");
    if (chosen.kind === "generate") expect(chosen.contents).toContain(image);
  });

  it.each(["requirements.txt", "pyproject.toml", "Pipfile"])(
    "requires declared Python startup for %s instead of serving source files",
    async (marker) => {
      const chosen = appDockerfile("railpack", [marker, "app.py", "index.html"]);
      expect(chosen.kind).toBe("missing");
      if (chosen.kind === "missing") expect(chosen.message).toMatch(/Python.*Dockerfile/);
      expect(appDockerfile("nixpacks", [marker, "Dockerfile"])).toEqual({
        kind: "existing",
        fileName: "Dockerfile",
      });
      const root = await mkdtemp(path.join(tmpdir(), "imemory-python-startup-"));
      try {
        await writeFile(path.join(root, marker), "");
        await expect(
          prepareAppBuild({
            commandId: "660e8400-e29b-41d4-a716-446655440098",
            target: { platform: "linux/amd64", runtimePort: 3000 },
            checkoutDir: root,
            spec: {
              repositoryUrl: "https://fixture.example.test/python",
              ref: "main",
              buildPack: "railpack",
              baseDirectory: ".",
            },
          }),
        ).rejects.toThrow(/Python.*Dockerfile/);
        await expect(stat(path.join(root, "pm.Dockerfile"))).rejects.toThrow();
      } finally {
        await removeBuildWorkspace(root);
      }
    },
  );

  it("rejects an unsupported context before writing a generated Dockerfile", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "imemory-unsupported-build-"));
    try {
      await writeFile(path.join(root, "pom.xml"), "<project/>");
      await expect(
        prepareAppBuild({
          commandId: "660e8400-e29b-41d4-a716-446655440099",
          target: { platform: "linux/amd64", runtimePort: 3000 },
          checkoutDir: root,
          spec: {
            repositoryUrl: "https://github.com/acme/demo",
            ref: "main",
            buildPack: "railpack",
            baseDirectory: ".",
          },
        }),
      ).rejects.toThrow(/Dockerfile.*base directory/);
      await expect(stat(path.join(root, "pm.Dockerfile"))).rejects.toThrow();
    } finally {
      await removeBuildWorkspace(root);
    }
  });

  it.each(["nixpacks", "railpack"] as const)(
    "records actual generated strategy for requested %s",
    async (requestedStrategy) => {
      const root = await mkdtemp(path.join(tmpdir(), "imemory-build-spec-"));
      const commit = "ab".repeat(20);
      try {
        await mkdir(path.join(root, ".git"));
        await writeFile(path.join(root, ".git", "HEAD"), `${commit}\n`);
        await mkdir(path.join(root, "web"));
        await writeFile(path.join(root, "web", "package.json"), "{}");
        const built = await prepareAppBuild({
          commandId: "660e8400-e29b-41d4-a716-446655440099",
          target: { platform: "linux/amd64", runtimePort: 3000 },
          checkoutDir: root,
          spec: {
            repositoryUrl: "https://github.com/acme/private",
            ref: "main",
            buildPack: requestedStrategy,
            baseDirectory: "web",
            gitSecretRef: "private-credential-reference",
          },
        });
        expect(built.buildSpec.source).toEqual({
          repositoryUrl: "https://github.com/acme/private",
          requestedRef: "main",
          resolvedCommit: commit,
          contextDirectory: "web",
        });
        expect(built.buildSpec.builder).toMatchObject({
          requestedStrategy,
          actualStrategy: "generated_dockerfile",
          dockerfile: "pm.Dockerfile",
        });
        expect(built.buildSpec.builder.dockerfileSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(built.buildSpec.inputs.privateSource).toBe(true);
        expect(JSON.stringify(built.buildSpec)).not.toContain("private-credential-reference");
        const diagnostic = formatBuildProvenance(built.buildSpec);
        expect(diagnostic).toContain(`requested=${requestedStrategy}`);
        expect(diagnostic).toContain("actual=generated_dockerfile");
        expect(diagnostic).toContain(commit);
        expect(diagnostic).not.toContain("https://");
        expect(diagnostic).not.toContain("private");
        await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main");
        const uncertain = await prepareAppBuild({
          commandId: built.buildSpec.logs.commandId,
          target: built.buildSpec.target,
          checkoutDir: root,
          spec: {
            repositoryUrl: "https://github.com/acme/demo",
            ref: commit,
            buildPack: requestedStrategy,
            baseDirectory: "web",
          },
        });
        expect(uncertain.buildSpec.source.resolvedCommit).toBeNull(); // A requested SHA is not a resolved checkout receipt.
      } finally {
        await removeBuildWorkspace(root);
      }
    },
  );

  it("forwards Dockerfile ARGs and secret ids without putting the token on argv", async () => {
    const contents = [
      "ARG NODE_VERSION=26",
      "ARG VITE_SUPABASE_URL",
      "RUN --mount=type=secret,id=NPM_TOKEN,target=/run/secrets/NPM_TOKEN echo ok",
    ].join("\n");
    expect(dockerfileBuildBindings(contents)).toEqual({
      args: ["NODE_VERSION", "VITE_SUPABASE_URL"],
      secrets: ["NPM_TOKEN"],
    });
    const commandId = "660e8400-e29b-41d4-a716-446655440099";
    const root = await mkdtemp(path.join(tmpdir(), "imemory-personal-node-build-"));
    const checkout = path.join(root, "src");
    const token = "ghp_exampletokenvalue";
    try {
      await mkdir(checkout, { recursive: true });
      await writeFile(path.join(checkout, "Dockerfile"), contents);
      const built = await prepareAppBuild({
        commandId,
        target: { platform: "linux/arm64", runtimePort: 8080 },
        spec: {
          repositoryUrl: "https://github.com/acme/demo",
          ref: "main",
          buildPack: "dockerfile",
          baseDirectory: ".",
        },
        checkoutDir: checkout,
        env: {
          NPM_TOKEN: token,
          VITE_SUPABASE_URL: "https://example.supabase.co",
          APP_TOKEN: "runtime-only-secret",
        },
      });
      expect(built.buildSpec).toMatchObject({
        schemaVersion: 1,
        kind: "personal-docker-build",
        builder: {
          requestedStrategy: "dockerfile",
          actualStrategy: "repository_dockerfile",
          dockerfile: "Dockerfile",
        },
        target: { platform: "linux/arm64", runtimePort: 8080 },
        source: { resolvedCommit: null },
        inputs: {
          permittedBuildArgumentNames: ["NODE_VERSION", "VITE_SUPABASE_URL"],
          buildSecretNames: ["NPM_TOKEN"],
        },
        artifact: { localImageConfigDigest: null, ociManifestReference: null },
        logs: { commandId },
      });
      expect(JSON.stringify(built.buildSpec)).not.toContain(token);
      expect(JSON.stringify(built.buildSpec)).not.toContain("runtime-only-secret");
      expect(formatBuildProvenance(built.buildSpec)).toContain("repository_dockerfile");
      expect(built.buildArgs.join(" ")).not.toContain(token);
      expect(built.buildArgs.join(" ")).not.toContain("APP_TOKEN");
      expect(built.buildArgs).toContain("VITE_SUPABASE_URL=https://example.supabase.co");
      const secret = built.buildArgs[built.buildArgs.indexOf("--secret") + 1] ?? "";
      expect(secret.startsWith("id=NPM_TOKEN,src=")).toBe(true);
      const file = secret.slice("id=NPM_TOKEN,src=".length);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(() => assertSafeDockerArgs(built.buildArgs)).not.toThrow();
    } finally {
      await removeBuildWorkspace(root);
    }
  });
});
