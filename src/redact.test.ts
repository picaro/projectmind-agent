import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("removes an explicitly supplied secret", () => {
    const out = redactSecrets("cloning with ghs_abcdefghijklmnopqrstuvwxyz01", [
      "ghs_abcdefghijklmnopqrstuvwxyz01",
    ]);
    expect(out).not.toContain("ghs_abcdefghijklmnopqrstuvwxyz01");
    expect(out).toContain("***");
  });

  it("removes token shapes it was never told about", () => {
    const text = [
      "installation ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "classic ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "oauth gho_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      "refresh ghr_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    ].join("\n");

    const out = redactSecrets(text);

    expect(out).not.toMatch(/gh[psour]_[A-Za-z0-9]{20,}/);
    expect(out.split("***")).toHaveLength(5);
  });

  it("strips credentials embedded in a remote URL", () => {
    const out = redactSecrets(
      "fatal: could not read from https://x-access-token:ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/org/app.git",
    );
    expect(out).not.toContain("ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(out).not.toContain("x-access-token:");
    expect(out).toContain("github.com/org/app.git");
  });

  it("handles multi-line stderr", () => {
    const out = redactSecrets("line one\nghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nline three");
    expect(out).toContain("line one");
    expect(out).toContain("line three");
    expect(out).not.toContain("ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("leaves ordinary text alone", () => {
    const text = "Cloning into '/Users/dev/.imemory/workspaces/my-app'... done. 42 files changed.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("ignores short or empty secrets that would blank the whole string", () => {
    // A one-character "secret" must not turn every occurrence into ***.
    expect(redactSecrets("a normal sentence", ["a", "", null, undefined])).toBe(
      "a normal sentence",
    );
  });

  it("passes through empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});
