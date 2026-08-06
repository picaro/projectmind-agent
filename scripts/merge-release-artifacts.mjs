#!/usr/bin/env node
/**
 * Merge platform build artifacts into a single release directory with manifest.json.
 *
 * Usage: node scripts/merge-release-artifacts.mjs [outputDir]
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_RELEASE_TARGETS, releaseReadme } from "./release-assets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(__dirname, "..");

async function main() {
  const outDir = resolve(process.argv[2] ?? join(agentRoot, "release"));
  const pkgJson = JSON.parse(await readFile(join(agentRoot, "package.json"), "utf8"));
  const version = String(pkgJson.version || "0.0.0");

  const files = await readdir(outDir);
  const zipFiles = new Set(files.filter((name) => name.endsWith(".zip")));

  const packaged = [];
  for (const target of ALL_RELEASE_TARGETS) {
    if (!zipFiles.has(target.zipName)) {
      throw new Error(`Missing release artifact: ${target.zipName}`);
    }
    const zipPath = join(outDir, target.zipName);
    const fileStat = await stat(zipPath);
    packaged.push({ ...target, bytes: fileStat.size });
  }

  const manifest = {
    version,
    releasedAt: new Date().toISOString(),
    assets: packaged.map((target) => ({
      id: target.id,
      label: target.label,
      os: target.os,
      arch: target.arch,
      filename: target.zipName,
      url: `/downloads/agent/${target.zipName}`,
      bytes: target.bytes,
    })),
  };

  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(outDir, "README.md"), releaseReadme(version), "utf8");

  console.log(`Merged ${packaged.length} artifacts into ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
