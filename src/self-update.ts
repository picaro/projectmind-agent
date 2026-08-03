/**
 * Desktop agent self-update against /downloads/agent/manifest.json.
 * Supports native zip installs and the Node.js zip (imemory-agent.cjs).
 * Source checkouts (tsx / repo) skip applying updates.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { getAgentVersion, isNewerVersion } from "./agent-version.js";

export type AgentInstallKind = "native" | "nodejs" | "source";

export type AgentUpdateAsset = {
  id: string;
  label?: string;
  os: string;
  arch: string;
  filename: string;
  url: string;
  bytes?: number;
};

export type AgentUpdateManifest = {
  version: string;
  releasedAt?: string;
  assets: AgentUpdateAsset[];
};

export type DetectedInstall = {
  kind: AgentInstallKind;
  /** Directory that owns the install (binary dir or nodejs package dir). */
  installDir: string;
  /** Path to the binary or entry script used to restart. */
  entryPath: string;
};

export type UpdateCheckResult =
  | { status: "disabled" }
  | { status: "skipped"; reason: string }
  | { status: "up_to_date"; localVersion: string; remoteVersion: string }
  | {
      status: "available";
      localVersion: string;
      remoteVersion: string;
      asset: AgentUpdateAsset;
      manifestUrl: string;
    }
  | { status: "error"; error: string };

export type UpdateApplyResult =
  | { status: "applied"; fromVersion: string; toVersion: string; assetId: string }
  | { status: "error"; error: string };

const MANIFEST_PATH = "/downloads/agent/manifest.json";
const PRESERVE_NAMES = new Set([".env"]);
const STALE_NATIVE_SUFFIX = ".imemory-old";
const DEFAULT_CHECK_MS = 6 * 60 * 60 * 1000; // 6h

export type SelfUpdateDeps = {
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  cwd?: string;
  execPath?: string;
  argv?: string[];
  nowMs?: () => number;
  log?: (message: string) => void;
  restart?: (install: DetectedInstall) => void;
  runNpmInstall?: (installDir: string) => Promise<void>;
  extractZip?: (zipPath: string, destDir: string) => Promise<void>;
  downloadToFile?: (url: string, destPath: string, fetchFn: typeof fetch) => Promise<void>;
};

export function isAutoUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.IMEMORY_AGENT_AUTO_UPDATE ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export function parseUpdateCheckIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  fallback = DEFAULT_CHECK_MS,
): number {
  const raw = env.IMEMORY_AGENT_UPDATE_CHECK_MS?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 60_000) {
    throw new Error("IMEMORY_AGENT_UPDATE_CHECK_MS must be a number >= 60000");
  }
  return Math.floor(value);
}

/** Derive public app origin from MCP URL (…/api/mcp → https://host). */
export function resolveUpdateBaseUrl(
  mcpUrl: string | URL,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override =
    env.IMEMORY_AGENT_UPDATE_URL?.trim() || env.IMEMORY_AGENT_DOWNLOAD_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");

  const url = typeof mcpUrl === "string" ? new URL(mcpUrl) : new URL(mcpUrl.href);
  // Strip /api/mcp or /api/mcp/... → origin (+ optional path prefix before /api)
  const path = url.pathname.replace(/\/+$/, "");
  const apiIdx = path.lastIndexOf("/api/mcp");
  if (apiIdx >= 0) {
    const prefix = path.slice(0, apiIdx);
    return `${url.origin}${prefix}`.replace(/\/+$/, "") || url.origin;
  }
  return url.origin;
}

export function manifestUrlForBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${MANIFEST_PATH}`;
}

export function resolveDownloadUrl(baseUrl: string, assetUrl: string): string {
  if (/^https?:\/\//i.test(assetUrl)) return assetUrl;
  const base = baseUrl.replace(/\/+$/, "");
  if (assetUrl.startsWith("/")) return `${base}${assetUrl}`;
  return `${base}/${assetUrl}`;
}

export function detectInstall(options: SelfUpdateDeps = {}): DetectedInstall {
  const cwd = resolve(options.cwd ?? process.cwd());
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const execBase = basename(execPath).toLowerCase();
  const isNodeBinary = execBase === "node" || execBase === "node.exe";

  if (!isNodeBinary) {
    return {
      kind: "native",
      installDir: dirname(execPath),
      entryPath: execPath,
    };
  }

  const scriptArg = argv[1] ? resolve(argv[1]) : "";
  const candidates = [
    scriptArg,
    join(cwd, "projectmind-agent.cjs"),
    join(dirname(scriptArg || cwd), "projectmind-agent.cjs"),
    join(cwd, "imemory-agent.cjs"),
    join(dirname(scriptArg || cwd), "imemory-agent.cjs"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if ((candidate.endsWith("projectmind-agent.cjs") || candidate.endsWith("imemory-agent.cjs")) && existsSync(candidate)) {
      return {
        kind: "nodejs",
        installDir: dirname(candidate),
        entryPath: candidate,
      };
    }
  }

  // Dev: tsx src/index.ts or similar — do not self-replace the repo.
  return {
    kind: "source",
    installDir: cwd,
    entryPath: scriptArg || join(cwd, "src", "index.ts"),
  };
}

export function pickUpdateAsset(
  manifest: AgentUpdateManifest,
  install: DetectedInstall,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): AgentUpdateAsset | null {
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (!assets.length) return null;

  if (install.kind === "nodejs") {
    return assets.find((a) => a.id === "nodejs" || a.os === "nodejs") ?? null;
  }

  if (install.kind !== "native") return null;

  const wantOs =
    platform === "darwin"
      ? "macos"
      : platform === "win32"
        ? "windows"
        : platform === "linux"
          ? "ubuntu"
          : null;
  if (!wantOs) return null;

  const wantArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  const exactId =
    wantOs === "macos" && wantArch === "arm64"
      ? "macos-arm64"
      : wantOs === "macos" && wantArch === "x64"
        ? "macos-x64"
        : wantOs === "windows"
          ? "windows-x64"
          : wantOs === "ubuntu"
            ? "ubuntu-x64"
            : null;

  if (exactId) {
    const byId = assets.find((a) => a.id === exactId);
    if (byId) return byId;
  }

  return (
    assets.find((a) => a.os === wantOs && (!wantArch || a.arch === wantArch || a.arch === "any")) ??
    assets.find((a) => a.os === wantOs) ??
    null
  );
}

export async function fetchUpdateManifest(
  manifestUrl: string,
  deps: SelfUpdateDeps = {},
): Promise<AgentUpdateManifest> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(manifestUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`manifest HTTP ${res.status} for ${manifestUrl}`);
  }
  const body = (await res.json()) as AgentUpdateManifest;
  if (!body || typeof body.version !== "string" || !Array.isArray(body.assets)) {
    throw new Error("manifest missing version/assets");
  }
  return body;
}

export async function checkForAgentUpdate(
  mcpUrl: string | URL,
  deps: SelfUpdateDeps = {},
): Promise<UpdateCheckResult> {
  const env = deps.env ?? process.env;
  if (!isAutoUpdateEnabled(env)) return { status: "disabled" };

  const install = detectInstall(deps);
  if (install.kind === "source") {
    return {
      status: "skipped",
      reason: "source checkout (auto-update applies to packaged installs only)",
    };
  }

  const localVersion = getAgentVersion({ installDir: install.installDir, env });
  const baseUrl = resolveUpdateBaseUrl(mcpUrl, env);
  const manifestUrl = manifestUrlForBase(baseUrl);

  try {
    const manifest = await fetchUpdateManifest(manifestUrl, deps);
    const remoteVersion = String(manifest.version || "").trim();
    if (!remoteVersion) return { status: "error", error: "manifest has empty version" };

    if (!isNewerVersion(remoteVersion, localVersion)) {
      return { status: "up_to_date", localVersion, remoteVersion };
    }

    const asset = pickUpdateAsset(
      manifest,
      install,
      deps.platform ?? process.platform,
      deps.arch ?? process.arch,
    );
    if (!asset) {
      return {
        status: "error",
        error: `no matching asset for ${install.kind}/${deps.platform ?? process.platform}/${deps.arch ?? process.arch}`,
      };
    }

    return { status: "available", localVersion, remoteVersion, asset, manifestUrl };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

async function defaultDownloadToFile(
  url: string,
  destPath: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`download returned empty body for ${url}`);
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(destPath));
}

export async function extractZipArchive(zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  if (process.platform === "win32") {
    const ps = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { encoding: "utf8" },
    );
    if (ps.status !== 0) {
      throw new Error(`Expand-Archive failed: ${ps.stderr || ps.stdout || ps.status}`);
    }
    return;
  }

  const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", destDir], { encoding: "utf8" });
  if (unzip.status !== 0) {
    throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout || unzip.status}`);
  }
}

async function copyExtractedFiles(extractDir: string, installDir: string): Promise<void> {
  // Some zips nest a single top-level folder; flatten if so.
  let sourceRoot = extractDir;
  const entries = await readdir(extractDir, { withFileTypes: true });
  if (entries.length === 1 && entries[0]?.isDirectory()) {
    sourceRoot = join(extractDir, entries[0].name);
  }

  const files = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of files) {
    if (PRESERVE_NAMES.has(entry.name)) continue;
    const from = join(sourceRoot, entry.name);
    const to = join(installDir, entry.name);
    if (entry.isDirectory()) {
      await cp(from, to, { recursive: true, force: true });
    } else {
      await replaceFile(from, to);
    }
  }
}

async function replaceFile(from: string, to: string): Promise<void> {
  const base = basename(to).toLowerCase();
  const isNativeBinary = base === "imemory-agent" || base === "imemory-agent.exe";

  if (isNativeBinary && existsSync(to)) {
    const stale = `${to}${STALE_NATIVE_SUFFIX}`;
    try {
      await rm(stale, { force: true });
    } catch {
      // ignore
    }
    try {
      await rename(to, stale);
    } catch {
      // If rename fails (rare), try direct overwrite.
      await copyFile(from, to);
      return;
    }
    await copyFile(from, to);
    if (process.platform !== "win32") {
      spawnSync("chmod", ["+x", to]);
    }
    return;
  }

  await copyFile(from, to);
  if (isNativeBinary && process.platform !== "win32") {
    spawnSync("chmod", ["+x", to]);
  }
}

export async function cleanupStaleNativeBinary(installDir: string): Promise<void> {
  for (const name of ["imemory-agent", "imemory-agent.exe"]) {
    const stale = join(installDir, `${name}${STALE_NATIVE_SUFFIX}`);
    if (!existsSync(stale)) continue;
    try {
      await rm(stale, { force: true });
    } catch {
      // Still locked on Windows until reboot — ignore.
    }
  }
}

async function defaultNpmInstall(installDir: string): Promise<void> {
  const result = spawnSync("npm", ["install", "--omit=dev"], {
    cwd: installDir,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`npm install failed: ${result.stderr || result.stdout || result.status}`);
  }
}

export function defaultRestart(install: DetectedInstall): void {
  const env = { ...process.env, IMEMORY_AGENT_JUST_UPDATED: "1" };
  if (install.kind === "native") {
    const child = spawn(install.entryPath, [], {
      cwd: install.installDir,
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
  } else if (install.kind === "nodejs") {
    const child = spawn(process.execPath, [install.entryPath], {
      cwd: install.installDir,
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
  }
  // Give the child a moment to spawn, then exit.
  setTimeout(() => process.exit(0), 250);
}

export async function applyAgentUpdate(
  mcpUrl: string | URL,
  available: Extract<UpdateCheckResult, { status: "available" }>,
  deps: SelfUpdateDeps = {},
): Promise<UpdateApplyResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const fetchFn = deps.fetchFn ?? fetch;
  const install = detectInstall(deps);
  const baseUrl = resolveUpdateBaseUrl(mcpUrl, env);
  const downloadUrl = resolveDownloadUrl(baseUrl, available.asset.url);

  const workRoot = await mkdtemp(join(tmpdir(), "imemory-agent-update-"));
  const zipPath = join(workRoot, available.asset.filename || "agent.zip");
  const extractDir = join(workRoot, "extract");

  try {
    log(`Downloading agent ${available.remoteVersion} (${available.asset.id})…`);
    const download = deps.downloadToFile ?? defaultDownloadToFile;
    await download(downloadUrl, zipPath, fetchFn);

    const st = await stat(zipPath);
    if (st.size < 100) throw new Error(`downloaded zip too small (${st.size} bytes)`);

    log("Extracting update…");
    const extract = deps.extractZip ?? extractZipArchive;
    await extract(zipPath, extractDir);

    // Preserve .env explicitly (also skipped in copy).
    const envPath = join(install.installDir, ".env");
    let envBackup: string | null = null;
    if (existsSync(envPath)) {
      envBackup = await readFile(envPath, "utf8");
    }

    await copyExtractedFiles(extractDir, install.installDir);

    if (envBackup != null) {
      await writeFile(envPath, envBackup, "utf8");
    }

    if (install.kind === "nodejs") {
      log("Running npm install for Node.js agent…");
      const npmInstall = deps.runNpmInstall ?? defaultNpmInstall;
      await npmInstall(install.installDir);
    }

    // Mark applied so next boot can clean stale binaries.
    await writeFile(
      join(install.installDir, ".imemory-agent-updated"),
      `${available.localVersion}→${available.remoteVersion}\n`,
      "utf8",
    );

    log(`Updated agent ${available.localVersion} → ${available.remoteVersion}. Restarting…`);
    const restart = deps.restart ?? defaultRestart;
    restart(install);

    return {
      status: "applied",
      fromVersion: available.localVersion,
      toVersion: available.remoteVersion,
      assetId: available.asset.id,
    };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Check for a newer agent online and apply when idle.
 * Returns true if an update was applied (process is exiting / restarting).
 */
export async function maybeSelfUpdate(
  mcpUrl: string | URL,
  options: SelfUpdateDeps & { busy?: boolean } = {},
): Promise<{ updated: boolean; detail: string }> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((msg: string) => console.log(msg));

  if (!isAutoUpdateEnabled(env)) {
    return { updated: false, detail: "auto-update disabled" };
  }
  if (options.busy) {
    return { updated: false, detail: "busy with job" };
  }

  const install = detectInstall(options);
  await cleanupStaleNativeBinary(install.installDir).catch(() => {});

  const check = await checkForAgentUpdate(mcpUrl, options);
  if (check.status === "disabled") return { updated: false, detail: "auto-update disabled" };
  if (check.status === "skipped") return { updated: false, detail: check.reason };
  if (check.status === "up_to_date") {
    return { updated: false, detail: `up to date (${check.localVersion})` };
  }
  if (check.status === "error") {
    log(`Auto-update check failed: ${check.error}`);
    return { updated: false, detail: check.error };
  }

  log(
    `New agent version online: ${check.remoteVersion} (local ${check.localVersion}, asset ${check.asset.id})`,
  );
  const applied = await applyAgentUpdate(mcpUrl, check, options);
  if (applied.status === "error") {
    log(`Auto-update failed: ${applied.error}`);
    return { updated: false, detail: applied.error };
  }
  return {
    updated: true,
    detail: `updated ${applied.fromVersion} → ${applied.toVersion}`,
  };
}
