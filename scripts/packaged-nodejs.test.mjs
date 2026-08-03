import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NODEJS_AGENT_ENGINES,
  NODEJS_AGENT_OVERRIDES,
  POSTINSTALL_HINT,
  POSTINSTALL_HINT_FILENAME,
  buildNodejsPackageJson,
  writeNodejsStartHelper,
  writePostinstallHint,
} from "./packaged-nodejs.mjs";

describe("packaged-nodejs", () => {
  it("builds package.json with start, postinstall, engines, and undici override", () => {
    const pkg = buildNodejsPackageJson("0.2.0", "^1.0.24");
    expect(pkg.scripts.start).toBe("node ./imemory-agent.cjs");
    expect(pkg.scripts.postinstall).toBe(`node ./${POSTINSTALL_HINT_FILENAME}`);
    expect(pkg.engines).toEqual(NODEJS_AGENT_ENGINES);
    expect(pkg.engines.node).toBe(">=22.13");
    expect(pkg.overrides).toEqual(NODEJS_AGENT_OVERRIDES);
    expect(pkg.overrides.undici).toBe("6.27.0");
    expect(pkg.dependencies["@cursor/sdk"]).toBe("^1.0.24");
  });

  it("postinstall hint tells users to use npm start not bare npm run", () => {
    expect(POSTINSTALL_HINT).toContain("npm start");
    expect(POSTINSTALL_HINT).toMatch(/not bare/);
    expect(POSTINSTALL_HINT).toContain("npm run");
    expect(POSTINSTALL_HINT).toContain("22.13");
  });

  it("writes postinstall-hint.cjs and start.command", async () => {
    const stage = await mkdtemp(join(tmpdir(), "imemory-packaged-nodejs-"));
    try {
      await writePostinstallHint(stage);
      const hint = await readFile(join(stage, POSTINSTALL_HINT_FILENAME), "utf8");
      expect(hint).toContain("npm start");
      expect(hint).toContain("npm run");

      await writeNodejsStartHelper(stage);
      const helper = await readFile(join(stage, "start.command"), "utf8");
      expect(helper).toContain("npm start");
      expect(helper).toContain("npm install");
      expect(helper).toContain("22.13");
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
});
