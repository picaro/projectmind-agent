import { describe, expect, it } from "vitest";
import { envFileHasImemoryApiKey, isImemoryApiKey } from "./api-key.js";

describe("isImemoryApiKey", () => {
  it("accepts project, global, and bucket prefixes", () => {
    expect(isImemoryApiKey("imk_abc")).toBe(true);
    expect(isImemoryApiKey("imgk_abc")).toBe(true);
    expect(isImemoryApiKey("imbk_abc")).toBe(true);
    expect(isImemoryApiKey("  imgk_abc  ")).toBe(true);
  });

  it("rejects missing or unknown prefixes", () => {
    expect(isImemoryApiKey(undefined)).toBe(false);
    expect(isImemoryApiKey("")).toBe(false);
    expect(isImemoryApiKey("sk-other")).toBe(false);
    expect(isImemoryApiKey("imemory_abc")).toBe(false);
  });
});

describe("envFileHasImemoryApiKey", () => {
  it("detects imk_ and imgk_ assignments", () => {
    expect(envFileHasImemoryApiKey("IMEMORY_API_KEY=imk_test\n")).toBe(true);
    expect(envFileHasImemoryApiKey("IMEMORY_API_KEY=imgk_global\n")).toBe(true);
    expect(envFileHasImemoryApiKey('IMEMORY_API_KEY="imgk_quoted"\n')).toBe(true);
  });

  it("ignores empty or invalid keys", () => {
    expect(envFileHasImemoryApiKey("IMEMORY_API_KEY=\n")).toBe(false);
    expect(envFileHasImemoryApiKey("IMEMORY_API_KEY=imk_your_api_key_here\n")).toBe(true);
    expect(envFileHasImemoryApiKey("# IMEMORY_API_KEY=imgk_x\nOTHER=1\n")).toBe(false);
  });
});
