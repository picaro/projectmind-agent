import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPersonalNodeEnvFiles } from "./agent-env.js";

describe("applyPersonalNodeEnvFiles", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("copies the docker flag and leaves other secrets behind", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-dotenv-"));
    const file = path.join(dir, ".env");
    await writeFile(
      file,
      [
        "SUPABASE_SERVICE_ROLE_KEY=do-not-copy",
        "CLOUDFLARE_API_TOKEN=do-not-copy",
        "IMEMORY_PERSONAL_NODE_DOCKER=1",
        "IMEMORY_PERSONAL_NODE_SERVER=http://127.0.0.1:8080",
      ].join("\n"),
      "utf8",
    );
    const loaded = await applyPersonalNodeEnvFiles({ PATH: "/usr/bin" }, [file]);
    expect(loaded.IMEMORY_PERSONAL_NODE_DOCKER).toBe("1");
    expect(loaded.IMEMORY_PERSONAL_NODE_SERVER).toBe("http://127.0.0.1:8080");
    expect(loaded.PATH).toBe("/usr/bin");
    expect(JSON.stringify(loaded)).not.toContain("do-not-copy");
    expect(loaded.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(loaded.CLOUDFLARE_API_TOKEN).toBeUndefined();
  });

  it("does not override a flag already set on the process", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pna-dotenv-"));
    const file = path.join(dir, ".env");
    await writeFile(file, "IMEMORY_PERSONAL_NODE_DOCKER=1\n", "utf8");
    const loaded = await applyPersonalNodeEnvFiles({ IMEMORY_PERSONAL_NODE_DOCKER: "0" }, [file]);
    expect(loaded.IMEMORY_PERSONAL_NODE_DOCKER).toBe("0");
  });
});
