#!/usr/bin/env node
/**
 * One-shot reclaim of leftover Mac-agent task worktrees.
 *
 * Usage:
 *   node scripts/prune-task-worktrees.mjs            # remove all leaves
 *   node scripts/prune-task-worktrees.mjs --max-age-ms=7200000
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function resolveManagedRoot() {
  const configured = process.env.IMEMORY_MANAGED_WORKSPACE_ROOT?.trim();
  if (configured) {
    if (configured === "~") return os.homedir();
    if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".imemory", "workspaces");
}

function parseMaxAgeMs(argv) {
  for (const arg of argv) {
    if (arg.startsWith("--max-age-ms=")) {
      const n = Number(arg.slice("--max-age-ms=".length));
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
  }
  return 0;
}

function estimateDirSizeBytes(dir, maxEntries = 2000) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0 && seen < maxEntries) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen >= maxEntries) break;
      seen += 1;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch {
        // ignore
      }
    }
  }
  return total;
}

function findBaseCheckout(managedRoot) {
  try {
    for (const name of fs.readdirSync(managedRoot)) {
      if (name.startsWith(".")) continue;
      const candidate = path.join(managedRoot, name);
      if (fs.existsSync(path.join(candidate, ".git"))) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

function removeLeaf(leaf, base) {
  if (base) {
    const r = spawnSync("git", ["-C", base, "worktree", "remove", "--force", leaf], {
      encoding: "utf8",
    });
    if (r.status === 0) return true;
  }
  fs.rmSync(leaf, { recursive: true, force: true });
  return !fs.existsSync(leaf);
}

const managedRoot = resolveManagedRoot();
const maxAgeMs = parseMaxAgeMs(process.argv.slice(2));
const now = Date.now();
const root = path.join(managedRoot, ".pm-task-workspaces");
const base = findBaseCheckout(managedRoot);

console.log(`managedRoot=${managedRoot}`);
console.log(`taskWorktrees=${root}`);
console.log(`maxAgeMs=${maxAgeMs}`);
if (!fs.existsSync(root)) {
  console.log("Nothing to prune.");
  process.exit(0);
}

let scanned = 0;
let removed = 0;
let failed = 0;
let bytes = 0;

for (const repoName of fs.readdirSync(root)) {
  const repoDir = path.join(root, repoName);
  let repoStat;
  try {
    repoStat = fs.statSync(repoDir);
  } catch {
    continue;
  }
  if (!repoStat.isDirectory()) continue;
  let leafNames;
  try {
    leafNames = fs.readdirSync(repoDir);
  } catch {
    continue;
  }
  for (const leafName of leafNames) {
    const leaf = path.join(repoDir, leafName);
    let leafStat;
    try {
      leafStat = fs.statSync(leaf);
    } catch {
      continue;
    }
    if (!leafStat.isDirectory()) continue;
    scanned += 1;
    const age = now - leafStat.mtimeMs;
    if (maxAgeMs > 0 && age < maxAgeMs) continue;
    bytes += estimateDirSizeBytes(leaf);
    try {
      if (removeLeaf(leaf, base)) {
        removed += 1;
        console.log(`removed ${leaf}`);
      } else {
        failed += 1;
        console.error(`failed ${leaf}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`failed ${leaf}: ${err instanceof Error ? err.message : err}`);
    }
  }
  try {
    if (fs.readdirSync(repoDir).length === 0) fs.rmdirSync(repoDir);
  } catch {
    // ignore
  }
}

if (base) {
  spawnSync("git", ["-C", base, "worktree", "prune"], { encoding: "utf8" });
}

console.log(
  `done scanned=${scanned} removed=${removed} failed=${failed} ~${Math.round(bytes / (1024 * 1024))}MB sampled`,
);
process.exit(failed > 0 ? 1 : 0);
