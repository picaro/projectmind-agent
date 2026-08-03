#!/usr/bin/env node
/**
 * Bundle the desktop agent and package unsigned zip executables for
 * macOS + Windows + Ubuntu/Linux (+ Node.js zip).
 * Output: ../../public/downloads/agent/
 *
 * Usage: node scripts/build-release.mjs
 * Env:
 *   AGENT_RELEASE_NODEJS_ONLY=1 — skip native pkg binaries
 *   AGENT_RELEASE_ONLY=ubuntu-x64,macos-arm64 — build only listed native ids
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { writePackagedEnvFiles } from "./packaged-env.mjs";
import {
  buildNodejsPackageJson,
  writeNodejsStartHelper,
  writePostinstallHint,
} from "./packaged-nodejs.mjs";
import { writeClearQuarantineHelper, writePackagedReadme } from "./packaged-readme.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(__dirname, "..");
const repoRoot = resolve(agentRoot, "..");
const outPublic = resolve(repoRoot, "public/downloads/agent");
const distDir = resolve(agentRoot, "dist-release");
const binDir = resolve(distDir, "bin");
const stageDir = resolve(distDir, "stage");

const require = createRequire(import.meta.url);
const pkgJson = JSON.parse(await readFile(resolve(agentRoot, "package.json"), "utf8"));
const version = String(pkgJson.version || "0.0.0");

const TARGETS = [
  {
    id: "macos-arm64",
    label: "macOS (Apple Silicon)",
    os: "macos",
    arch: "arm64",
    pkgTarget: "node22-macos-arm64",
    binaryName: "projectmind-agent",
    zipName: "projectmind-agent-macos-arm64.zip",
    bytes: 0,
  },
  {
    id: "macos-x64",
    label: "macOS (Intel)",
    os: "macos",
    arch: "x64",
    pkgTarget: "node22-macos-x64",
    binaryName: "projectmind-agent",
    zipName: "projectmind-agent-macos-x64.zip",
    bytes: 0,
  },
  {
    id: "windows-x64",
    label: "Windows (x64)",
    os: "windows",
    arch: "x64",
    pkgTarget: "node22-win-x64",
    binaryName: "projectmind-agent.exe",
    zipName: "projectmind-agent-windows-x64.zip",
    bytes: 0,
  },
  {
    id: "ubuntu-x64",
    label: "Ubuntu (x64)",
    os: "ubuntu",
    arch: "x64",
    pkgTarget: "node22-linux-x64",
    binaryName: "projectmind-agent",
    zipName: "projectmind-agent-ubuntu-x64.zip",
    bytes: 0,
  },
];

const onlyNativeIds = (process.env.AGENT_RELEASE_ONLY ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function nativeTargetsToBuild() {
  if (!onlyNativeIds.length) return TARGETS;
  const selected = TARGETS.filter((t) => onlyNativeIds.includes(t.id));
  if (!selected.length) {
    throw new Error(
      `AGENT_RELEASE_ONLY matched no targets (got ${onlyNativeIds.join(", ")}); known: ${TARGETS.map((t) => t.id).join(", ")}`,
    );
  }
  return selected;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: agentRoot,
    stdio: "inherit",
    encoding: "utf8",
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

async function ensureZipTool() {
  const zip = spawnSync("zip", ["-v"], { encoding: "utf8" });
  if (zip.status === 0) return;
  throw new Error("Need `zip` on PATH to build release archives");
}

async function writeSetupReadme(dir, target) {
  await writePackagedReadme(dir, target, version, {
    writeClearQuarantine: writeClearQuarantineHelper,
  });
}

async function zipFolder(folder, zipPath) {
  await rm(zipPath, { force: true });
  run("zip", ["-r", "-q", zipPath, "."], { cwd: folder });
}

const NODEJS_TARGET = {
  id: "nodejs",
  label: "Node.js (cross-platform)",
  os: "nodejs",
  arch: "any",
  zipName: "projectmind-agent-nodejs.zip",
  bytes: 0,
};

/** Set AGENT_RELEASE_NODEJS_ONLY=1 to skip native pkg binaries (faster local rebuild). */
const nodejsOnly = process.env.AGENT_RELEASE_NODEJS_ONLY === "1";

async function readExistingManifestAssets() {
  const existingManifestPath = join(outPublic, "manifest.json");
  if (!existsSync(existingManifestPath)) return [];
  try {
    const existing = JSON.parse(await readFile(existingManifestPath, "utf8"));
    return Array.isArray(existing.assets) ? existing.assets : [];
  } catch {
    return [];
  }
}

function applyExistingBytes(targets, existingAssets) {
  for (const asset of existingAssets) {
    const match = targets.find((t) => t.id === asset.id);
    if (match && typeof asset.bytes === "number") match.bytes = asset.bytes;
  }
}

async function packageNodejsZip(bundlePath) {
  console.log("Packaging nodejs…");
  const stage = join(stageDir, NODEJS_TARGET.id);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  await copyFile(bundlePath, join(stage, "projectmind-agent.cjs"));
  await writePackagedEnvFiles(stage, agentRoot);
  await writeSetupReadme(stage, NODEJS_TARGET);

  const cursorSdkRange =
    pkgJson.dependencies?.["@cursor/sdk"] ?? pkgJson.devDependencies?.["@cursor/sdk"] ?? "^1.0.24";
  const nodePackage = buildNodejsPackageJson(version, cursorSdkRange);
  await writeFile(join(stage, "package.json"), `${JSON.stringify(nodePackage, null, 2)}\n`, "utf8");
  await writePostinstallHint(stage);
  await writeNodejsStartHelper(stage);

  const zipPath = join(outPublic, NODEJS_TARGET.zipName);
  await zipFolder(stage, zipPath);
  const st = await stat(zipPath);
  console.log(`  → ${zipPath} (${st.size} bytes)`);
  NODEJS_TARGET.bytes = st.size;
  return NODEJS_TARGET;
}

async function main() {
  const buildDate = new Date().toISOString();
  await ensureZipTool();
  if (!nodejsOnly) {
    await rm(distDir, { recursive: true, force: true });
  }
  await mkdir(binDir, { recursive: true });
  await mkdir(stageDir, { recursive: true });
  await mkdir(outPublic, { recursive: true });

  console.log("Installing mac-agent deps…");
  run("npm", ["ci"], { cwd: agentRoot });

  console.log("Bundling with esbuild…");
  const esbuild = require("esbuild");
  const bundlePath = resolve(distDir, "bundle.cjs");
  await esbuild.build({
    entryPoints: [resolve(agentRoot, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: bundlePath,
    // Native optional dep — CLI runners work without it in the packaged binary.
    // Node.js zip installs @cursor/sdk via npm so cursor_sdk works.
    external: ["@cursor/sdk"],
    define: {
      "process.env.IMEMORY_AGENT_EMBEDDED_VERSION": JSON.stringify(version),
      "process.env.IMEMORY_AGENT_EMBEDDED_BUILD_DATE": JSON.stringify(buildDate),
    },
    logLevel: "info",
  });

  const existingAssets = await readExistingManifestAssets();
  const buildTargets = nativeTargetsToBuild();
  const packagedById = new Map();

  // Seed with catalog order so partial rebuilds keep a full manifest.
  for (const target of TARGETS) {
    packagedById.set(target.id, target);
  }
  applyExistingBytes(TARGETS, existingAssets);

  if (!nodejsOnly) {
    const pkgCli = resolve(agentRoot, "node_modules/.bin/pkg");

    for (const target of buildTargets) {
      console.log(`Packaging ${target.id}…`);
      const outBinary = join(binDir, `${target.id}-${target.binaryName}`);
      const args = [bundlePath, "--sea", "-t", target.pkgTarget, "-o", outBinary];
      if (existsSync(pkgCli)) {
        run(pkgCli, args);
      } else {
        run("npx", ["--no-install", "@yao-pkg/pkg", ...args]);
      }

      let binaryPath = outBinary;
      try {
        await stat(binaryPath);
      } catch {
        const alt = `${outBinary}.exe`;
        await stat(alt);
        binaryPath = alt;
      }

      const stage = join(stageDir, target.id);
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      await copyFile(binaryPath, join(stage, target.binaryName));
      if (target.os !== "windows") {
        run("chmod", ["+x", join(stage, target.binaryName)]);
      }
      await writePackagedEnvFiles(stage, agentRoot);
      await writeSetupReadme(stage, target);

      const zipPath = join(outPublic, target.zipName);
      await zipFolder(stage, zipPath);
      const st = await stat(zipPath);
      console.log(`  → ${zipPath} (${st.size} bytes)`);
      target.bytes = st.size;
      packagedById.set(target.id, target);
    }
  }

  const nodejsAsset = await packageNodejsZip(bundlePath);
  packagedById.set(nodejsAsset.id, nodejsAsset);

  const packaged = [
    ...TARGETS.map((t) => packagedById.get(t.id)),
    packagedById.get(NODEJS_TARGET.id),
  ].filter(Boolean);

  const manifest = {
    version,
    releasedAt: new Date().toISOString(),
    assets: packaged.map((t) => ({
      id: t.id,
      label: t.label,
      os: t.os,
      arch: t.arch,
      filename: t.zipName,
      url: `/downloads/agent/${t.zipName}`,
      bytes: t.bytes,
    })),
  };
  await writeFile(
    join(outPublic, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(outPublic, "README.md"),
    `# ProjectMind desktop agent downloads\n\nVersion **${version}** (unsigned zip).\n\nIncludes native macOS / Windows / Ubuntu binaries and a **Node.js** cross-platform zip.\n\nEach zip includes a **platform-specific \`README.txt\`** (how to run on that OS), plus a sample **\`.env\`** (and \`.env.example\`) pointed at \`https://projectm.dev/api/mcp\` — edit your API key and workspace allowlist before running.\n\n| Zip | Run |\n| --- | --- |\n| macOS | \`./imemory-agent\` (clear quarantine first) |\n| Windows | \`.\\\\imemory-agent.exe\` |\n| Ubuntu | \`chmod +x ./imemory-agent && ./imemory-agent\` |\n| Node.js | \`npm install && npm start\` (Node 22.13+; not bare \`npm run\`) |\n\n**macOS trust:** after unzip, run \`xattr -dr com.apple.quarantine .\` (or double-click \`clear-quarantine.command\` in the macOS zip), or System Settings → Privacy & Security → Open Anyway. See \`mac-agent/README.md\`.\n\nBuilt by \`npm run build:release --prefix mac-agent\`.\n`,
    "utf8",
  );

  console.log("Done. Artifacts in public/downloads/agent/");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
