import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureArgv,
  captureWrapperSource,
  findPlaywrightConfig,
  listArgv,
  writeCaptureWrapper,
} from "./continuous-test-capture.js";
import type { ContinuousTestCapture } from "./improvement-contracts/continuous-test-job.js";

const everyRun: ContinuousTestCapture = { screenshot: "on", video: "on", trace: "retain-on-failure" };

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-ct-cap-")));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("findPlaywrightConfig", () => {
  it("follows Playwright's lookup order and returns null when there is none", () => {
    expect(findPlaywrightConfig(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "playwright.config.mjs"), "");
    fs.writeFileSync(path.join(dir, "playwright.config.js"), "");
    expect(findPlaywrightConfig(dir)).toBe(path.join(dir, "playwright.config.js"));
    fs.writeFileSync(path.join(dir, "playwright.config.ts"), "");
    expect(findPlaywrightConfig(dir)).toBe(path.join(dir, "playwright.config.ts"));
  });
});

describe("capture wrapper", () => {
  it("spreads the base config and overrides use at the top level and in every project (ESM)", () => {
    const src = captureWrapperSource(path.join(dir, "playwright.config.ts"), everyRun);
    expect(src).toContain('import loaded from "./playwright.config.ts";');
    expect(src).toContain("// @ts-nocheck");
    expect(src).toContain('const overrides = {"screenshot":"on","video":"on","trace":"retain-on-failure"};');
    expect(src).toContain("base.projects.map");
    expect(src).toContain("export default config;");
  });

  it("uses require/module.exports for CommonJS configs", () => {
    const src = captureWrapperSource(path.join(dir, "playwright.config.cjs"), everyRun);
    expect(src).toContain('require("./playwright.config.cjs")');
    expect(src).toContain("module.exports = config;");
    expect(src).not.toContain("import ");
  });

  it("produces a config that really merges (evaluated as ESM)", async () => {
    fs.writeFileSync(
      path.join(dir, "playwright.config.mjs"),
      'export default { testDir: "./e2e", use: { baseURL: "https://x", video: "off" }, projects: [{ name: "a", use: { viewport: null } }, { name: "b" }] };\n',
    );
    const wrapper = writeCaptureWrapper(path.join(dir, "playwright.config.mjs"), everyRun);
    expect(path.basename(wrapper)).toBe("playwright.projectmind.config.mjs");
    const { default: config } = await import(wrapper);
    expect(config.testDir).toBe("./e2e");
    expect(config.use).toEqual({ baseURL: "https://x", ...everyRun });
    expect(config.projects.map((p: { use: unknown }) => p.use)).toEqual([
      { viewport: null, ...everyRun },
      everyRun,
    ]);
  });

  it("refuses capture values outside the allowlist", () => {
    expect(() =>
      captureWrapperSource(path.join(dir, "playwright.config.ts"), {
        ...everyRun,
        video: 'on"}; process.exit(1); //' as ContinuousTestCapture["video"],
      }),
    ).toThrow(/allowlist/);
  });
});

describe("argv", () => {
  const argv = ["npx", "playwright", "test", "--reporter=json", "--grep", "@smoke"];

  it("appends --config unless the command already names one", () => {
    expect(captureArgv(argv, "/w/c.ts")).toEqual([...argv, "--config", "/w/c.ts"]);
    expect(captureArgv([...argv, "-c", "x.ts"], "/w/c.ts")).toEqual([...argv, "-c", "x.ts"]);
    expect(captureArgv([...argv, "--config=x.ts"], "/w/c.ts")).toEqual([...argv, "--config=x.ts"]);
  });

  it("builds a --list preflight without the JSON reporter", () => {
    expect(listArgv([...argv, "--config", "/w/c.ts"])).toEqual([
      "npx",
      "playwright",
      "test",
      "--grep",
      "@smoke",
      "--config",
      "/w/c.ts",
      "--list",
      "--reporter=list",
    ]);
  });
});
