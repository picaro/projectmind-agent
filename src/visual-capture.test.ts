import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  captureAndSaveVisualState,
  isUiRelatedChange,
  normalizeRoute,
  parseViewport,
  prioritizeRoutes,
  resolveBaseUrl,
  resolveConfiguredRoutes,
  routesFromChangedFiles,
  shouldCaptureVisualState,
  type VisualCaptureOptions,
} from "./visual-capture.js";

describe("isUiRelatedChange", () => {
  it("detects UI file extensions and path conventions", () => {
    expect(isUiRelatedChange(["src/lib/foo.ts"])).toBe(false);
    expect(isUiRelatedChange(["src/components/Button.tsx"])).toBe(true);
    expect(isUiRelatedChange(["src/routes/dashboard.tsx"])).toBe(true);
    expect(isUiRelatedChange(["styles/main.css"])).toBe(true);
    expect(isUiRelatedChange(["README.md", "src/pages/home.jsx"])).toBe(true);
  });
});

describe("shouldCaptureVisualState", () => {
  it("honors explicit enabled flag", () => {
    expect(shouldCaptureVisualState({ enabled: true, changedFiles: [] })).toBe(true);
    expect(shouldCaptureVisualState({ enabled: false, changedFiles: ["a.tsx"] })).toBe(false);
  });
  it("honors env override", () => {
    expect(
      shouldCaptureVisualState({
        changedFiles: ["a.tsx"],
        env: { IMEMORY_VISUAL_SNAPSHOT: "0" },
      }),
    ).toBe(false);
    expect(
      shouldCaptureVisualState({
        changedFiles: [],
        env: { IMEMORY_VISUAL_SNAPSHOT: "1" },
      }),
    ).toBe(true);
  });
  it("auto-runs only when UI files changed", () => {
    expect(
      shouldCaptureVisualState({
        changedFiles: ["src/lib/foo.ts"],
        env: {},
      }),
    ).toBe(false);
    expect(
      shouldCaptureVisualState({
        changedFiles: ["src/components/X.tsx"],
        env: {},
      }),
    ).toBe(true);
    expect(shouldCaptureVisualState({ changedFiles: [], env: {} })).toBe(false);
  });
});

describe("routesFromChangedFiles", () => {
  it("maps TanStack route files", () => {
    const routes = routesFromChangedFiles([
      "src/routes/_authenticated/dashboard.tsx",
      "src/routes/index.tsx",
      "src/lib/x.ts",
    ]);
    expect(routes).toContain("/dashboard");
    expect(routes).toContain("/");
  });
});

describe("prioritizeRoutes / normalizeRoute", () => {
  it("puts affected first and normalizes", () => {
    expect(prioritizeRoutes(["/", "/dashboard"], ["/dashboard/"])).toEqual(["/dashboard", "/"]);
    expect(normalizeRoute("https://app.dev/settings?x=1#y")).toBe("/settings");
  });
});

describe("parseViewport / resolveBaseUrl / resolveConfiguredRoutes", () => {
  it("parses viewport strings", () => {
    expect(parseViewport("1440x900")).toEqual({ width: 1440, height: 900 });
    expect(parseViewport(undefined)).toEqual({ width: 1280, height: 720 });
  });
  it("resolves base URL and routes from env", () => {
    expect(resolveBaseUrl({ IMEMORY_VISUAL_BASE_URL: "http://x:3000/" })).toBe("http://x:3000");
    expect(resolveConfiguredRoutes({ IMEMORY_VISUAL_ROUTES: "/,/dashboard" })).toEqual([
      "/",
      "/dashboard",
    ]);
    expect(resolveConfiguredRoutes({})).toBeNull();
  });
});

describe("captureAndSaveVisualState", () => {
  const backupEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = ["IMEMORY_VISUAL_SNAPSHOT", "IMEMORY_VISUAL_BASE_URL", "IMEMORY_VISUAL_ROUTES"];
    for (const key of keys) {
      backupEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(backupEnv)) {
      if (val !== undefined) {
        process.env[key] = val;
      } else {
        delete process.env[key];
      }
    }
  });

  function makePage(opts: {
    title?: string;
    failGoto?: boolean;
    failScreenshotAfterError?: boolean;
  }) {
    return {
      setViewportSize: vi.fn(async () => undefined),
      goto: vi.fn(async () => {
        if (opts.failGoto) throw new Error("navigation timeout");
      }),
      title: vi.fn(async () => opts.title ?? "Dashboard · App"),
      screenshot: vi.fn(async () => {
        if (opts.failGoto && opts.failScreenshotAfterError) {
          throw new Error("blank");
        }
        return Buffer.from("png-bytes");
      }),
      close: vi.fn(async () => undefined),
    };
  }

  async function run(overrides: Partial<VisualCaptureOptions> = {}) {
    const logs: string[] = [];
    const saves: unknown[] = [];
    const page = makePage({ title: "Dashboard · App" });
    const result = await captureAndSaveVisualState({
      client: {} as never,
      cwd: "/tmp/repo",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      enabled: true,
      baseUrl: "http://localhost:8080",
      routes: ["/dashboard"],
      changedFiles: ["src/components/X.tsx"],
      onLog: (m) => logs.push(m),
      launchBrowser: async () => ({
        newPage: async () => page,
        close: async () => undefined,
      }),
      saveSnapshot: async (args) => {
        saves.push(args);
        return { ok: true };
      },
      readGitMeta: async () => ({ commit: "abc123", branch: "main" }),
      checkHealth: async () => true,
      ...overrides,
    });
    return { result, logs, saves, page };
  }

  it("skips when disabled / no UI changes", async () => {
    const { result } = await run({
      enabled: undefined,
      changedFiles: ["src/lib/foo.ts"],
    });
    // Force env off by overriding enabled false path via changed files only —
    // shouldCapture with non-UI files and no env → false.
    expect(result.attempted).toBe(false);
    expect(result.pagesCaptured).toBe(0);
  });

  it("captures a page and uploads via saveSnapshot", async () => {
    const { result, saves, page } = await run();
    expect(result.ok).toBe(true);
    expect(result.pagesCaptured).toBe(1);
    expect(page.goto).toHaveBeenCalledWith(
      "http://localhost:8080/dashboard",
      expect.objectContaining({ waitUntil: "networkidle" }),
    );
    expect(saves).toHaveLength(1);
    const save = saves[0] as {
      status: string;
      route: string;
      title: string;
      commit: string;
      contentBase64: string;
    };
    expect(save.status).toBe("passed");
    expect(save.route).toBe("/dashboard");
    expect(save.title).toContain("Dashboard");
    expect(save.commit).toBe("abc123");
    expect(Buffer.from(save.contentBase64, "base64").toString()).toBe("png-bytes");
  });

  it("still captures a debug screenshot when navigation fails", async () => {
    const page = makePage({ failGoto: true, title: "Error" });
    const saves: unknown[] = [];
    const result = await captureAndSaveVisualState({
      client: {} as never,
      cwd: "/tmp/repo",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      enabled: true,
      routes: ["/broken"],
      onLog: () => undefined,
      launchBrowser: async () => ({
        newPage: async () => page,
        close: async () => undefined,
      }),
      saveSnapshot: async (args) => {
        saves.push(args);
      },
      readGitMeta: async () => ({ commit: null, branch: null }),
      checkHealth: async () => true,
    });
    expect(result.pagesCaptured).toBe(1);
    expect(result.pagesFailed).toBe(1);
    expect((saves[0] as { status: string }).status).toBe("failed");
    expect(page.screenshot).toHaveBeenCalled();
  });

  it("reports a clear message when Playwright is unavailable", async () => {
    const result = await captureAndSaveVisualState({
      client: {} as never,
      cwd: "/tmp/does-not-exist-playwright",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      enabled: true,
      routes: ["/"],
      onLog: () => undefined,
      launchBrowser: async () => {
        throw new Error("ENOENT");
      },
      readGitMeta: async () => ({ commit: null, branch: null }),
      checkHealth: async () => true,
    });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Playwright/i);
  });

  it("skips capture when health check fails", async () => {
    const { result, logs, saves } = await run({
      checkHealth: async () => false,
    });
    expect(result.attempted).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/health check failed/);
    expect(saves).toHaveLength(0);
    expect(logs.some((l) => l.includes("health check failed"))).toBe(true);
  });

  it("proceeds when health check passes", async () => {
    const { result, saves } = await run({
      checkHealth: async () => true,
    });
    expect(result.attempted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.pagesCaptured).toBe(1);
    expect(saves).toHaveLength(1);
  });
});
