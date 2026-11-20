/**
 * Local image build from a git repository ProjectMind already named.
 * The agent clones with Docker and builds with Docker. It does not install
 * git, nixpacks, or any other CLI, and it does not mount the Docker socket.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { nodeBuildInputs, type NodeInstall } from "./node-build-inputs.ts";
import { frozenLanguageInputs } from "./frozen-language-inputs.ts";

import { PayloadRejected } from "./validate.ts";
import bases from "./build-base-images.json" with { type: "json" };

const GIT_PACKS = new Set(["nixpacks", "dockerfile", "static", "railpack"]);
const GIT_REF = /^[A-Za-z0-9._/-]{1,128}$/;
const GIT_URL = /^https:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9._~+-]+)+$/;
const LOCAL_TAG = /^pn-(fetch|app)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export type GitBuildSpec = {
  repositoryUrl: string;
  ref: string;
  buildPack: "nixpacks" | "dockerfile" | "static" | "railpack";
  baseDirectory: string;
  gitSecretRef?: string;
};

/** Execution-local provenance. A local config ID is never a registry manifest address. */
export type PersonalBuildSpec = {
  schemaVersion: 1;
  kind: "personal-docker-build";
  source: {
    repositoryUrl: string;
    requestedRef: string;
    resolvedCommit: string | null;
    contextDirectory: string;
  };
  builder: {
    requestedStrategy: GitBuildSpec["buildPack"];
    actualStrategy: "repository_dockerfile" | "generated_dockerfile";
    dockerfile: string;
    dockerfileSha256: string;
  };
  /** Expected deployment platform, not proof that the build produced that platform. */
  target: { platform: "linux/arm64" | "linux/amd64"; runtimePort: number };
  inputs: {
    permittedBuildArgumentNames: string[];
    buildSecretNames: string[];
    privateSource: boolean;
  };
  artifact: { localImageConfigDigest: string | null; ociManifestReference: null };
  logs: { commandId: string };
};

/** Deliberately excludes repository/ref, credential references, input names and all values. */
export function formatBuildProvenance(spec: PersonalBuildSpec): string {
  return `Build spec v${spec.schemaVersion}: requested=${spec.builder.requestedStrategy}; actual=${spec.builder.actualStrategy}; expected platform=${spec.target.platform}; runtime port=${spec.target.runtimePort}; source commit=${spec.source.resolvedCommit ?? "unknown"}; local image config ID=${spec.artifact.localImageConfigDigest ?? "unknown"}; OCI manifest=not published; log command=${spec.logs.commandId}.`;
}

export type GitCredential = { username: string; token: string };

export function parseGitBuildSpec(value: unknown): GitBuildSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const allowed = new Set(["repositoryUrl", "ref", "buildPack", "baseDirectory", "gitSecretRef"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return null;
  }
  if (typeof body.repositoryUrl !== "string" || !GIT_URL.test(body.repositoryUrl)) return null;
  if (body.repositoryUrl.includes("@") || body.repositoryUrl.includes("..")) return null;
  if (typeof body.ref !== "string" || !GIT_REF.test(body.ref) || body.ref.includes(".."))
    return null;
  if (typeof body.buildPack !== "string" || !GIT_PACKS.has(body.buildPack)) return null;
  if (
    typeof body.baseDirectory !== "string" ||
    body.baseDirectory.includes("..") ||
    !/^(?:\.|[A-Za-z0-9._/-]{1,128})$/.test(body.baseDirectory)
  ) {
    return null;
  }
  const spec: GitBuildSpec = {
    repositoryUrl: body.repositoryUrl,
    ref: body.ref,
    buildPack: body.buildPack as GitBuildSpec["buildPack"],
    baseDirectory: body.baseDirectory,
  };
  if (body.gitSecretRef !== undefined) {
    if (typeof body.gitSecretRef !== "string") return null;
    spec.gitSecretRef = body.gitSecretRef;
  }
  return spec;
}

export function localImageTag(role: "fetch" | "app", commandId: string): string {
  return `pn-${role}-${commandId.trim().toLowerCase()}`;
}

export function assertLocalImageTag(value: string): boolean {
  return LOCAL_TAG.test(value);
}

/** True when an absolute path stays inside the agent temp directory. */
export function pathUnderTemp(file: string): boolean {
  if (!file || !path.isAbsolute(file) || file.includes("\0") || file.includes("..")) return false;
  const root = path.resolve(os.tmpdir());
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function fetchDockerfile(privateRepo: boolean): string {
  const git = privateRepo
    ? `git -c credential.helper='!f() { u=$(sed -n 1p /run/secrets/gitcred); p=$(sed -n 2p /run/secrets/gitcred); echo "username=$u"; echo "password=$p"; }; f'`
    : "git";
  const mount = privateRepo ? "--mount=type=secret,id=gitcred \\\n    " : "";
  // A partial clone (--filter=blob:none) leaves a promisor remote. Checkout then
  // downloads missing files with plain git, which has no credential and fails
  // private fetches with "could not read Username". Fetch the requested ref
  // with its blobs instead, and keep the credential on checkout.
  return `FROM ${bases.git}
ARG REPO_URL
ARG GIT_REF
ARG FETCH_REQUEST_ID
ENV GIT_TERMINAL_PROMPT=0
RUN ${mount}test -n "$FETCH_REQUEST_ID" \\
 && git init -q /src \\
 && git -C /src remote add origin "$REPO_URL" \\
 && ${git} -C /src fetch --depth 1 origin "$GIT_REF" \\
 && ${git} -C /src checkout --detach FETCH_HEAD
`;
}

/** Docker build output with the failure lines kept and the progress lines dropped. */
export function dockerFailureText(exitCode: number, output: string): string {
  const lines = output
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^#\d+\s+[0-9.]+(?:\s+ERROR:)?\s*/, "").trim())
    .filter(Boolean);
  const important = lines.filter((line) =>
    /fatal:|could not read Username|could not fetch|NPM_TOKEN is empty|ERROR:|npm ERR!|ELIFECYCLE|failed to solve/i.test(
      line,
    ),
  );
  const body = (important.length > 0 ? important : lines)
    .slice(-6)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 900);
  return `Git build failed (${exitCode}). ${body || "docker build produced no output."}`;
}

function nodeDockerfile(files: readonly string[], validated?: NodeInstall): string {
  const pnpm = files.includes("pnpm-lock.yaml");
  const yarn = files.includes("yarn.lock");
  const npm = files.includes("package-lock.json");
  const install = pnpm
    ? "pnpm install --frozen-lockfile"
    : yarn
      ? "yarn install --frozen-lockfile"
      : npm
        ? "npm ci"
        : "npm install";
  const start = pnpm ? "pnpm" : yarn ? "yarn" : "npm";
  const runner = validated?.runner ?? [start];
  const buildArgs = JSON.stringify([...runner.slice(1), "run", "build"]);
  return `FROM ${bases.node}
WORKDIR /app
COPY . .
RUN corepack enable && ${validated?.install ?? install} && node -e 'const p=require("./package.json");if(p.scripts&&p.scripts.build)require("node:child_process").execFileSync(${JSON.stringify(runner[0])},${buildArgs},{stdio:"inherit"})'
ENV PORT=3000
EXPOSE 3000
CMD ${JSON.stringify([...runner, "start"])}
`;
}

function staticDockerfile(): string {
  return `FROM ${bases.nginx}
COPY . /usr/share/nginx/html
RUN printf 'server { listen 3000; location / { root /usr/share/nginx/html; } }\\n' > /etc/nginx/conf.d/default.conf && sed -i 's@^[[:space:]]*pid[[:space:]].*;@pid /tmp/nginx.pid;@' /etc/nginx/nginx.conf && chown -R nginx:nginx /var/cache/nginx
USER nginx
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
`;
}

function goDockerfile(): string {
  return `FROM ${bases.golang} AS build
ENV GOTOOLCHAIN=local
WORKDIR /src
COPY . .
RUN go build -mod=readonly -trimpath -o /out/app .
FROM ${bases.debian}
COPY --from=build /out/app /app
ENV PORT=3000
EXPOSE 3000
CMD ["/app"]
`;
}

function phpDockerfile(): string {
  return `FROM ${bases.composer} AS composer
FROM ${bases.php}
COPY --from=composer /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY . .
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist
ENV PORT=3000
EXPOSE 3000
CMD ["php", "-S", "0.0.0.0:3000", "-t", "."]
`;
}

function rubyDockerfile(bundlerVersion?: string): string {
  const runner = bundlerVersion ? ["bundle", `_${bundlerVersion}_`] : ["bundle"];
  return `FROM ${bases.ruby}
WORKDIR /app
COPY . .
ENV BUNDLE_FROZEN=true
${bundlerVersion ? `RUN gem install bundler --version ${bundlerVersion} --no-document\n` : ""}RUN ${runner.join(" ")} install
ENV PORT=3000
EXPOSE 3000
CMD ${JSON.stringify([...runner, "exec", "rackup", "-o", "0.0.0.0", "-p", "3000"])}
`;
}

function rustDockerfile(): string {
  return `FROM ${bases.rust} AS build
WORKDIR /src
COPY . .
RUN mkdir -p /out && cargo build --release --locked && find target/release -maxdepth 1 -type f -executable -exec cp {} /out/app \\;
FROM ${bases.debian}
COPY --from=build /out/app /app
ENV PORT=3000
EXPOSE 3000
CMD ["/app"]
`;
}

export type AppDockerfile =
  | { kind: "generate"; contents: string }
  | { kind: "existing"; fileName: string }
  | { kind: "missing"; message: string };

/** Personal builds use Dockerfiles; requested Nixpacks/Railpack labels do not invoke those builders. */
export function appDockerfile(
  buildPack: GitBuildSpec["buildPack"],
  files: readonly string[],
): AppDockerfile {
  // Only markers in the selected build context count; a nested app needs its own base directory.
  const names = new Set(files.filter((file) => !file.includes("/") && !file.includes("\\")));
  const dockerfile = [...names].find((name) => name.toLowerCase() === "dockerfile");
  if (buildPack === "dockerfile") {
    if (!dockerfile) {
      return {
        kind: "missing",
        message: "This repository has no Dockerfile. The computer did not start a container.",
      };
    }
    return { kind: "existing", fileName: dockerfile };
  }
  // The repository's own Dockerfile knows its runtime, private registries and
  // native deps. A generated guess does not, so it only fills in when none exists.
  if (dockerfile) return { kind: "existing", fileName: dockerfile };
  if (buildPack === "static") return { kind: "generate", contents: staticDockerfile() };
  if (names.has("package.json")) return { kind: "generate", contents: nodeDockerfile([...names]) };
  if (names.has("requirements.txt") || names.has("pyproject.toml") || names.has("Pipfile")) {
    return {
      kind: "missing",
      message:
        "Python application startup is not declared. Add a Dockerfile with the application's start command in the selected base directory. No application build or container was started.",
    };
  }
  if (names.has("go.mod")) return { kind: "generate", contents: goDockerfile() };
  if (names.has("composer.json")) return { kind: "generate", contents: phpDockerfile() };
  if (names.has("Gemfile")) return { kind: "generate", contents: rubyDockerfile() };
  if (names.has("Cargo.toml")) return { kind: "generate", contents: rustDockerfile() };
  if (names.has("index.html")) return { kind: "generate", contents: staticDockerfile() };
  return {
    kind: "missing",
    message:
      "This personal build stack is unsupported. Add a Dockerfile or select the supported app's base directory. No application build or container was started.",
  };
}

export function digestFromImageInspect(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (IMAGE_DIGEST.test(trimmed)) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = Array.isArray(parsed) ? parsed[0] : parsed;
    const id = record && typeof record === "object" ? (record as { Id?: unknown }).Id : undefined;
    if (typeof id === "string" && IMAGE_DIGEST.test(id.trim())) return id.trim();
  } catch {
    return null;
  }
  return null;
}

export async function writeGitCredentialFile(
  file: string,
  credential: GitCredential,
): Promise<void> {
  if (!pathUnderTemp(file)) {
    throw new PayloadRejected(
      "forbidden_command_field",
      "Git credential file is not under the agent temp directory.",
    );
  }
  if (/[\r\n]/.test(credential.username) || /[\r\n]/.test(credential.token)) {
    throw new PayloadRejected("invalid_input", "Git credential values must be a single line.");
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${credential.username}\n${credential.token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export type FetchWorkspace = {
  root: string;
  checkoutDir: string;
  buildArgs: string[];
  createArgs: string[];
  copyArgs: string[];
  removeContainerArgs: string[];
  removeImageArgs: string[];
  credentialFile: string | null;
};

export async function prepareFetchWorkspace(input: {
  commandId: string;
  spec: GitBuildSpec;
  credential: GitCredential | null;
}): Promise<FetchWorkspace> {
  const root = await mkdir(path.join(os.tmpdir(), "imemory-personal-node-build", input.commandId), {
    recursive: true,
    mode: 0o700,
  }).then(() => path.join(os.tmpdir(), "imemory-personal-node-build", input.commandId));
  const fetchDir = path.join(root, "fetch");
  const checkoutDir = path.join(root, "src");
  await mkdir(fetchDir, { recursive: true, mode: 0o700 });
  await mkdir(checkoutDir, { recursive: true, mode: 0o700 });
  const privateRepo = Boolean(input.credential);
  await writeFile(path.join(fetchDir, "Dockerfile"), fetchDockerfile(privateRepo), { mode: 0o600 });
  let credentialFile: string | null = null;
  if (input.credential) {
    credentialFile = path.join(root, "git-cred");
    await writeGitCredentialFile(credentialFile, input.credential);
  }
  const tag = localImageTag("fetch", input.commandId);
  const dockerfile = path.join(fetchDir, "Dockerfile");
  const buildArgs = [
    "build",
    "-t",
    tag,
    "-f",
    dockerfile,
    "--build-arg",
    `REPO_URL=${input.spec.repositoryUrl}`,
    "--build-arg",
    `GIT_REF=${input.spec.ref}`,
    "--build-arg",
    `FETCH_REQUEST_ID=${input.commandId}`,
  ];
  if (credentialFile) buildArgs.push("--secret", `id=gitcred,src=${credentialFile}`);
  buildArgs.push(fetchDir);
  return {
    root,
    checkoutDir,
    buildArgs,
    createArgs: ["create", "--name", tag, tag],
    copyArgs: ["cp", `${tag}:/src/.`, checkoutDir],
    removeContainerArgs: ["rm", "-f", tag],
    removeImageArgs: ["image", "rm", tag],
    credentialFile,
  };
}

const BUILD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * ARG names and BuildKit secret ids declared in a Dockerfile.
 * Secret ids are not also passed as build args, so a token is not stored in image history.
 */
export function dockerfileBuildBindings(contents: string): { args: string[]; secrets: string[] } {
  const args: string[] = [];
  const secrets: string[] = [];
  for (const raw of contents.split("\n")) {
    const line = (raw.split("#")[0] ?? "").trim();
    const arg = /^ARG\s+([A-Za-z_][A-Za-z0-9_]{0,127})\b/.exec(line);
    if (arg?.[1] && !args.includes(arg[1])) args.push(arg[1]);
    if (!line.includes("type=secret")) continue;
    for (const match of line.matchAll(/\bid=([A-Za-z_][A-Za-z0-9_]{0,127})\b/g)) {
      const id = match[1];
      if (id && !secrets.includes(id)) secrets.push(id);
    }
  }
  return { args, secrets };
}

export async function prepareAppBuild(input: {
  commandId: string;
  spec: GitBuildSpec;
  checkoutDir: string;
  target: PersonalBuildSpec["target"];
  /** Redeemed project env. Only Dockerfile ARG names and secret ids are forwarded. */
  env?: Record<string, string>;
}): Promise<{ buildArgs: string[]; inspectArgs: string[]; buildSpec: PersonalBuildSpec }> {
  const context =
    input.spec.baseDirectory === "."
      ? input.checkoutDir
      : path.join(input.checkoutDir, input.spec.baseDirectory);
  await mkdir(context, { recursive: true, mode: 0o700 });
  const names = await readdir(context).catch(() => [] as string[]);
  const chosen = appDockerfile(input.spec.buildPack, names);
  if (chosen.kind === "missing") {
    throw new PayloadRejected("invalid_input", chosen.message);
  }
  const dockerfile =
    chosen.kind === "existing"
      ? path.join(context, chosen.fileName)
      : path.join(context, "pm.Dockerfile");
  const language =
    chosen.kind === "generate" &&
    input.spec.buildPack !== "static" &&
    !names.includes("package.json")
      ? await frozenLanguageInputs(context, names)
      : {};
  const contents =
    chosen.kind === "generate"
      ? input.spec.buildPack !== "static" && names.includes("package.json")
        ? nodeDockerfile(names, await nodeBuildInputs(context, names))
        : language.bundlerVersion
          ? rubyDockerfile(language.bundlerVersion)
          : chosen.contents
      : await readFile(dockerfile, "utf8");
  if (chosen.kind === "generate") {
    await writeFile(dockerfile, contents, { mode: 0o600 });
  }
  const bindings = dockerfileBuildBindings(contents);
  // Fetch checks out detached HEAD. Missing/symbolic/malformed receipts stay unknown;
  // the requested ref (even a full SHA) is not evidence of what was checked out.
  const head = await readFile(path.join(input.checkoutDir, ".git", "HEAD"), "utf8").catch(() => "");
  const resolvedCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.trim()) ? head.trim() : null;
  const buildSpec: PersonalBuildSpec = {
    schemaVersion: 1,
    kind: "personal-docker-build",
    source: {
      repositoryUrl: input.spec.repositoryUrl,
      requestedRef: input.spec.ref,
      resolvedCommit,
      contextDirectory: input.spec.baseDirectory,
    },
    builder: {
      requestedStrategy: input.spec.buildPack,
      actualStrategy: chosen.kind === "existing" ? "repository_dockerfile" : "generated_dockerfile",
      dockerfile: chosen.kind === "existing" ? chosen.fileName : "pm.Dockerfile",
      dockerfileSha256: createHash("sha256").update(contents).digest("hex"),
    },
    target: { ...input.target },
    inputs: {
      permittedBuildArgumentNames: bindings.args.filter((name) => !bindings.secrets.includes(name)),
      buildSecretNames: [...bindings.secrets],
      privateSource: Boolean(input.spec.gitSecretRef),
    },
    artifact: { localImageConfigDigest: null, ociManifestReference: null },
    logs: { commandId: input.commandId },
  };
  const env = input.env ?? {};
  const secretRoot = path.dirname(path.resolve(input.checkoutDir));
  const tag = localImageTag("app", input.commandId);
  const buildArgs = ["build", "-t", tag, "-f", dockerfile];
  const secretIds = new Set(bindings.secrets);
  for (const id of bindings.secrets) {
    const value = env[id];
    if (typeof value !== "string" || value.length === 0) continue;
    if (!BUILD_NAME.test(id) || /[\r\n\0]/.test(value)) {
      throw new PayloadRejected("invalid_input", `Build secret ${id} must be a single line.`);
    }
    const file = path.join(secretRoot, `build-secret-${id}`);
    if (!pathUnderTemp(file)) {
      throw new PayloadRejected(
        "forbidden_command_field",
        "Build secret file is not under the agent temp directory.",
      );
    }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
    buildArgs.push("--secret", `id=${id},src=${file}`);
  }
  for (const key of bindings.args) {
    if (secretIds.has(key)) continue;
    const value = env[key];
    if (typeof value !== "string" || value.length === 0) continue;
    if (!BUILD_NAME.test(key) || /[\r\n\0]/.test(value) || value.includes("..")) {
      throw new PayloadRejected("invalid_input", `Build arg ${key} is not usable.`);
    }
    buildArgs.push("--build-arg", `${key}=${value}`);
  }
  buildArgs.push(context);
  return {
    buildArgs,
    buildSpec,
    inspectArgs: ["image", "inspect", tag],
  };
}

export async function removeBuildWorkspace(root: string): Promise<void> {
  if (!pathUnderTemp(root)) return;
  await rm(root, { recursive: true, force: true });
}
