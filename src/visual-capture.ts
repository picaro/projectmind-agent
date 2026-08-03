/**
 * Automatic visual snapshot capture for the Mac agent.
 *
 * After a successful implement-phase job that touched UI/frontend files, the
 * agent visits the configured routes with Playwright, takes a full-page
 * screenshot of every page (even on failure), and uploads each artifact via
 * the ProjectMind MCP tool `saveVisualSnapshot`. The server derives the
 * logical page name and stores the files under Assets/UI/<Page>/.
 *
 * Enable / disable:
 *   IMEMORY_VISUAL_SNAPSHOT=1   force on
 *   IMEMORY_VISUAL_SNAPSHOT=0   force off
 *   (unset)                     auto — run when UI-related files changed
 *
 * Target:
 *   IMEMORY_VISUAL_BASE_URL     default http://localhost:8080
 *   IMEMORY_VISUAL_ROUTES       comma-separated routes (overrides discovery)
 *   IMEMORY_VISUAL_VIEWPORT     e.g. 1280x720 (default)
 *
 * Playwright is loaded dynamically from the managed project's node_modules
 * (or a globally installed `playwright` / `playwright-core`). Capture is
 * skipped gracefully when Playwright is unavailable.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callToolJson } from "./mcp-client.js";
import { runGit } from "./git-publish.js";

export type VisualCaptureLog = (message: string, kind?: "info" | "error" | "log") => void;

export type VisualCaptureOptions = {
  client: Client;
  cwd: string;
  taskId: string;
  projectSlug?: string | null;
  /** Override the auto/env enable decision. */
  enabled?: boolean;
  baseUrl?: string;
  routes?: string[];
  /** Files changed by this task (used for UI detection + route prioritization). */
  changedFiles?: string[];
  viewport?: { width: number; height: number };
  environment?: string;
  onLog: VisualCaptureLog;
  /** Inject for tests — launch a browser and return a page factory. */
  launchBrowser?: () => Promise<BrowserLike>;
  /** Inject for tests — upload a single snapshot. */
  saveSnapshot?: (args: SaveSnapshotArgs) => Promise<unknown>;
  /** Inject for tests — resolve git metadata. */
  readGitMeta?: (cwd: string) => Promise<{ commit: string | null; branch: string | null }>;
  /** Inject for tests — check if the app is healthy before capturing. */
  checkHealth?: (baseUrl: string) => Promise<boolean>;
};

export type SaveSnapshotArgs = {
  contentBase64: string;
  status: "passed" | "failed";
  route: string;
  title: string | null;
  taskId: string;
  commit: string | null;
  branch: string | null;
  environment: string;
  viewport: { width: number; height: number };
  error?: string | null;
  projectSlug?: string | null;
  capturedAt: string;
};

export type VisualCaptureResult = {
  attempted: boolean;
  ok: boolean;
  detail: string;
  pagesCaptured: number;
  pagesFailed: number;
};

type PageLike = {
  goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown>;
  title: () => Promise<string>;
  screenshot: (options?: { fullPage?: boolean; type?: string }) => Promise<Buffer>;
  setViewportSize?: (size: { width: number; height: number }) => Promise<void>;
  close?: () => Promise<void>;
};

type BrowserLike = {
  newPage: () => Promise<PageLike>;
  close: () => Promise<void>;
};

const UI_FILE_RE = /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html|pcss)$/i;
const UI_PATH_RE = /(?:^|\/)(?:src\/)?(?:routes|pages|app|components|ui|layouts|styles)\//i;

/** True when at least one changed file looks UI/frontend related. */
export function isUiRelatedChange(files: string[]): boolean {
  return files.some((f) => UI_FILE_RE.test(f) || UI_PATH_RE.test(f));
}

/**
 * Decide whether visual capture should run.
 * Explicit env wins; otherwise auto-run when UI files changed.
 */
export function shouldCaptureVisualState(input: {
  enabled?: boolean;
  changedFiles?: string[];
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (input.enabled != null) return input.enabled;
  const env = input.env ?? process.env;
  const flag = (env.IMEMORY_VISUAL_SNAPSHOT ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  // Auto: only when we know UI files changed. Empty list = unknown → skip
  // (avoid capturing every backend-only task by default).
  if (!input.changedFiles || input.changedFiles.length === 0) return false;
  return isUiRelatedChange(input.changedFiles);
}

/** Map TanStack / Next-style route files to route paths (best-effort). */
export function routesFromChangedFiles(files: string[]): string[] {
  const routes = new Set<string>();
  const routeFileRe = /(?:^|\/)(?:src\/)?routes\/(.+)\.(?:tsx|ts|jsx|js)$/;
  for (const file of files) {
    const match = file.replace(/\\/g, "/").match(routeFileRe);
    if (!match) continue;
    let rel = match[1]!;
    const base = rel.split("/").pop() ?? rel;
    if (base.startsWith("__") || base.endsWith(".test")) continue;
    rel = rel.replace(/\//g, ".");
    const parts = rel
      .split(".")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .filter((p) => p !== "index" && p !== "route")
      .filter((p) => !p.startsWith("_") && !/^\(.*\)$/.test(p))
      .filter((p) => !/^[:$*[]/.test(p) && !/^\d+$/.test(p));
    const path = "/" + parts.join("/");
    routes.add(path === "/" ? "/" : path.replace(/\/+$/, "") || "/");
  }
  return [...routes];
}

/** Affected routes first, then the rest (de-duplicated, normalized). */
export function prioritizeRoutes(all: string[], affected: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (route: string) => {
    const norm = normalizeRoute(route);
    if (seen.has(norm)) return;
    seen.add(norm);
    ordered.push(norm);
  };
  for (const r of affected) push(r);
  for (const r of all) push(r);
  return ordered;
}

export function normalizeRoute(route: string): string {
  let path = route.trim();
  const scheme = path.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i);
  if (scheme) path = scheme[1] ?? "/";
  path = path.split("#")[0]!.split("?")[0]!;
  if (!path.startsWith("/")) path = `/${path}`;
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

export function parseViewport(raw: string | undefined): { width: number; height: number } {
  const match = (raw ?? "").trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (match) {
    return { width: Number(match[1]), height: Number(match[2]) };
  }
  return { width: 1280, height: 720 };
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw =
    env.IMEMORY_VISUAL_BASE_URL?.trim() ||
    env.PLAYWRIGHT_BASE_URL?.trim() ||
    "http://localhost:8080";
  return raw.replace(/\/+$/, "");
}

export function resolveConfiguredRoutes(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.IMEMORY_VISUAL_ROUTES?.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map(normalizeRoute);
}

export async function readGitMeta(
  cwd: string,
): Promise<{ commit: string | null; branch: string | null }> {
  const [head, branch] = await Promise.all([
    runGit(cwd, ["rev-parse", "HEAD"]),
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
  ]);
  return {
    commit: head.code === 0 ? head.stdout.trim() || null : null,
    branch: branch.code === 0 ? branch.stdout.trim() || null : null,
  };
}

export async function listChangedFilesFromHead(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["show", "--pretty=format:", "--name-only", "HEAD"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Files changed between two commits (inclusive of working tree vs from when toSha omitted). */
export async function listChangedFilesBetween(
  cwd: string,
  fromCommit: string,
  toCommit?: string | null,
): Promise<string[]> {
  const args = toCommit?.trim()
    ? ["diff", "--name-only", `${fromCommit}..${toCommit}`]
    : ["diff", "--name-only", fromCommit];
  const result = await runGit(cwd, args);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Dynamically load Playwright from the managed project or the agent runtime. */
export async function loadPlaywrightBrowser(
  cwd: string,
): Promise<{ browser: BrowserLike; close: () => Promise<void> } | null> {
  const candidates = [
    join(cwd, "node_modules", "playwright"),
    join(cwd, "node_modules", "playwright-core"),
    "playwright",
    "playwright-core",
  ];

  for (const candidate of candidates) {
    try {
      let mod: { chromium?: { launch: (opts?: object) => Promise<BrowserLike> } } | null = null;
      if (candidate.startsWith("/") || candidate.includes("node_modules")) {
        const require = createRequire(pathToFileURL(join(cwd, "package.json")).href);
        mod = require(candidate);
      } else {
        mod = (await import(candidate)) as typeof mod;
      }
      if (!mod?.chromium?.launch) continue;
      const browser = await mod.chromium.launch({ headless: true });
      return {
        browser,
        close: async () => {
          try {
            await browser.close();
          } catch {
            // ignore
          }
        },
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Default health check: GET {baseUrl}/api/health with a 5 s timeout.
 * Returns true when the response is 2xx, false otherwise.
 */
export async function defaultCheckHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Visit each route, capture a full-page screenshot (even on failure), and
 * upload via MCP. Returns a summary suitable for the agent job log.
 */
export async function captureAndSaveVisualState(
  options: VisualCaptureOptions,
): Promise<VisualCaptureResult> {
  const env = process.env;
  const changedFiles = options.changedFiles ?? [];

  if (
    !shouldCaptureVisualState({
      enabled: options.enabled,
      changedFiles,
    })
  ) {
    return {
      attempted: false,
      ok: true,
      detail: "Visual snapshot skipped (disabled or no UI changes)",
      pagesCaptured: 0,
      pagesFailed: 0,
    };
  }

  const baseUrl = (options.baseUrl ?? resolveBaseUrl(env)).replace(/\/+$/, "");

  // Health check: verify the app is alive before launching Playwright.
  const checkHealth = options.checkHealth ?? defaultCheckHealth;
  const healthy = await checkHealth(baseUrl);
  if (!healthy) {
    const detail = `Visual snapshot skipped: app health check failed (${baseUrl}/api/health)`;
    options.onLog(detail, "error");
    return { attempted: false, ok: true, detail, pagesCaptured: 0, pagesFailed: 0 };
  }

  const viewport = options.viewport ?? parseViewport(env.IMEMORY_VISUAL_VIEWPORT);
  const environment =
    options.environment ??
    env.IMEMORY_VISUAL_ENVIRONMENT?.trim() ??
    (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") ? "local" : "preview");

  const configured = options.routes ?? resolveConfiguredRoutes(env);
  const discovered = routesFromChangedFiles(changedFiles);
  const defaults = configured ?? (discovered.length > 0 ? discovered : ["/"]);
  const routes = prioritizeRoutes(defaults, discovered);

  options.onLog(
    `Visual snapshot: capturing ${routes.length} page(s) at ${baseUrl} (viewport ${viewport.width}x${viewport.height})`,
  );

  const git = (await (options.readGitMeta ?? readGitMeta)(options.cwd).catch(() => ({
    commit: null,
    branch: null,
  }))) ?? { commit: null, branch: null };

  let browserHandle: { browser: BrowserLike; close: () => Promise<void> } | null = null;
  try {
    if (options.launchBrowser) {
      const browser = await options.launchBrowser();
      browserHandle = { browser, close: () => browser.close() };
    } else {
      browserHandle = await loadPlaywrightBrowser(options.cwd);
    }
  } catch (err) {
    const detail = `Visual snapshot skipped: Playwright launch failed (${err instanceof Error ? err.message : err})`;
    options.onLog(detail, "error");
    return { attempted: true, ok: false, detail, pagesCaptured: 0, pagesFailed: 0 };
  }

  if (!browserHandle) {
    const detail =
      "Visual snapshot skipped: Playwright not installed in the managed project (npm i -D playwright && npx playwright install chromium)";
    options.onLog(detail, "error");
    return { attempted: true, ok: false, detail, pagesCaptured: 0, pagesFailed: 0 };
  }

  const save =
    options.saveSnapshot ??
    (async (args: SaveSnapshotArgs) =>
      callToolJson(options.client, "saveVisualSnapshot", {
        contentBase64: args.contentBase64,
        status: args.status,
        route: args.route,
        title: args.title ?? undefined,
        taskId: args.taskId,
        commit: args.commit ?? undefined,
        branch: args.branch ?? undefined,
        environment: args.environment,
        viewport: args.viewport,
        error: args.error ?? undefined,
        projectSlug: args.projectSlug ?? undefined,
        capturedAt: args.capturedAt,
        artifactType: "screenshot",
      }));

  let pagesCaptured = 0;
  let pagesFailed = 0;
  const errors: string[] = [];

  try {
    for (const route of routes) {
      const page = await browserHandle.browser.newPage();
      if (page.setViewportSize) {
        await page.setViewportSize(viewport);
      }
      const url = `${baseUrl}${route === "/" ? "/" : route}`;
      let status: "passed" | "failed" = "passed";
      let title: string | null = null;
      let error: string | null = null;
      let png: Buffer | null = null;

      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
        title = (await page.title().catch(() => null)) || null;
        png = await page.screenshot({ fullPage: true, type: "png" });
      } catch (err) {
        status = "failed";
        error = err instanceof Error ? err.message : String(err);
        pagesFailed += 1;
        // Still try to capture whatever is on screen for debugging.
        try {
          title = (await page.title().catch(() => null)) || title;
          png = await page.screenshot({ fullPage: true, type: "png" });
        } catch {
          // nothing to capture
        }
      } finally {
        try {
          await page.close?.();
        } catch {
          // ignore
        }
      }

      if (!png) {
        errors.push(`${route}: no screenshot (${error ?? "unknown"})`);
        options.onLog(`Visual snapshot failed for ${route}: ${error ?? "no screenshot"}`, "error");
        continue;
      }

      try {
        await save({
          contentBase64: png.toString("base64"),
          status,
          route,
          title,
          taskId: options.taskId,
          commit: git.commit,
          branch: git.branch,
          environment,
          viewport,
          error,
          projectSlug: options.projectSlug ?? null,
          capturedAt: new Date().toISOString(),
        });
        pagesCaptured += 1;
        options.onLog(`Visual snapshot ${status}: ${route}${title ? ` (“${title}”)` : ""}`);
      } catch (err) {
        pagesFailed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${route}: upload failed (${msg})`);
        options.onLog(`Visual snapshot upload failed for ${route}: ${msg}`, "error");
      }
    }
  } finally {
    await browserHandle.close();
  }

  const ok = pagesFailed === 0 && pagesCaptured > 0;
  const detail = ok
    ? `Visual snapshot: ${pagesCaptured} page(s) saved to Assets/UI`
    : `Visual snapshot: captured=${pagesCaptured} failed=${pagesFailed}${
        errors.length ? ` (${errors.slice(0, 3).join("; ")})` : ""
      }`;
  options.onLog(detail, ok ? "info" : "error");
  return { attempted: true, ok, detail, pagesCaptured, pagesFailed };
}
