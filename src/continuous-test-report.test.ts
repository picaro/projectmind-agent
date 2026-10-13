import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseReportText,
  prepareReportForUpload,
  reportHasFailures,
  scrubSecrets,
  secretEnvValues,
  selectFailureAttachments,
  selectRunAttachments,
  summarizeError,
} from "./continuous-test-report.js";

function report(results: Array<Record<string, unknown>>, status = "unexpected") {
  return {
    config: { rootDir: "/abs" },
    suites: [
      {
        title: "a.spec.ts",
        specs: [{ title: "t @smoke", tests: [{ status, projectName: "chromium", results }] }],
      },
    ],
    errors: [{ message: "global token=abcdefgh1234" }],
  };
}

describe("scrubSecrets", () => {
  it("removes bearer tokens, JWTs, GitHub tokens, URL credentials, key=value secrets and known values", () => {
    const text = [
      "Authorization: Bearer abcdef1234567890",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123",
      "https://user:pass1234@github.com/x",
      'password=hunter2hunter2 "api_key": "k_live_1234"',
      "stripe sk_live_abcdefghijklmnop1234",
      "custom value-of-agent-secret-xyz",
    ].join("\n");
    const out = scrubSecrets(text, ["value-of-agent-secret-xyz"]);
    for (const leaked of [
      "abcdef1234567890",
      "eyJhbGciOiJIUzI1NiJ9",
      "ghp_",
      "pass1234",
      "hunter2hunter2",
      "k_live_1234",
      "sk_live_",
      "value-of-agent-secret-xyz",
    ]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain("password=***");
  });

  it("collects this agent's secret-looking env values", () => {
    expect(secretEnvValues({ IMEMORY_API_KEY: "a", PATH: "/bin", GH_TOKEN: "b" }).sort()).toEqual(["a", "b"]);
  });

  it("summarizeError is single-line, ANSI-free and capped at 500 chars", () => {
    const out = summarizeError(`\u001b[31mboom\u001b[0m\n${"x".repeat(900)}`);
    expect(out.startsWith("boom x")).toBe(true);
    expect(out.length).toBe(500);
  });
});

describe("parseReportText", () => {
  it("parses a plain report and one preceded by stdout noise", () => {
    const json = JSON.stringify(report([]), null, 2);
    expect(parseReportText(json)?.suites).toBeDefined();
    expect(parseReportText(`[WebServer] starting\n${json}`)?.suites).toBeDefined();
  });

  it("rejects missing/invalid/non-report JSON", () => {
    expect(parseReportText("")).toBeNull();
    expect(parseReportText("not json")).toBeNull();
    expect(parseReportText('{"foo":1}')).toBeNull();
  });
});

describe("prepareReportForUpload", () => {
  it("strips attachment bodies, stdio, config, absolute paths; keeps verdict fields; scrubs errors", () => {
    const prepared = prepareReportForUpload(
      report([
        {
          status: "failed",
          stdout: [{ text: "out" }],
          stderr: [{ text: "err" }],
          attachments: [{ name: "s", contentType: "image/png", body: "BASE64BODY", path: "/Users/me/x/s.png" }],
          errors: [{ message: "Bearer abcdefghijklmnop failed" }],
        },
      ]),
      [],
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const text = JSON.stringify(prepared.report);
    expect(text).not.toMatch(/BASE64BODY|"out"|"err"|\/Users\/me|abcdefghijklmnop|abcdefgh1234/);
    expect(prepared.report.config).toBeUndefined();
    const test = (prepared.report.suites as any)[0].specs[0].tests[0];
    expect(test).toMatchObject({ status: "unexpected", projectName: "chromium" });
    expect(test.results[0]).toMatchObject({ status: "failed", attachments: [{ path: "s.png" }] });
  });

  it("trims progressively to fit the cap, then gives up", () => {
    const big = report([{ status: "failed", errors: [{ message: "e".repeat(50_000) }] }]);
    const small = prepareReportForUpload(big, [], 5_000);
    expect(small.ok).toBe(true);
    if (small.ok) {
      expect(small.level).toBeGreaterThan(0);
      expect(small.bytes).toBeLessThanOrEqual(5_000);
    }
    expect(prepareReportForUpload(big, [], 100)).toMatchObject({ ok: false });
  });
});

describe("selectFailureAttachments", () => {
  it("only failed results, only files inside the workspace, within size limits, screenshots first", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-ct-att-")));
    try {
      const write = (name: string, size: number) => {
        const p = path.join(root, name);
        fs.writeFileSync(p, Buffer.alloc(size, 1));
        return p;
      };
      const video = write("v.webm", 10);
      const shot = write("s.png", 10);
      const big = write("big.png", 1_000);
      const har = write("network.har", 10);
      const symlink = path.join(root, "link.png");
      fs.symlinkSync("/etc/hosts", symlink);
      const passedShot = write("passed.png", 10);
      const r = {
        suites: [
          {
            title: "f",
            specs: [
              {
                title: "t",
                tests: [
                  {
                    status: "unexpected",
                    results: [
                      { status: "passed", attachments: [{ contentType: "image/png", path: passedShot }] },
                      {
                        status: "timedOut",
                        attachments: [
                          { contentType: "video/webm", path: video },
                          { contentType: "image/png", path: shot },
                          { contentType: "image/png", path: big },
                          { contentType: "application/zip", path: har },
                          { contentType: "image/png", path: symlink },
                          { contentType: "text/plain", path: shot },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      expect(reportHasFailures(r)).toBe(true);
      const picked = selectFailureAttachments(r, root, { maxFiles: 5, maxBytesPerFile: 100 });
      expect(picked.map((p) => p.name)).toEqual(["s.png", "v.webm"]);
      expect(selectFailureAttachments(r, root, { maxFiles: 1, maxBytesPerFile: 100 })).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reportHasFailures is false for an all-green report", () => {
    expect(reportHasFailures(report([{ status: "passed" }], "expected"))).toBe(false);
  });
});

describe("selectRunAttachments", () => {
  it("failed tests first, passing media only when asked, never setup media or passing traces, within a byte budget", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pm-ct-run-")));
    try {
      const write = (name: string, size: number) => {
        const p = path.join(root, name);
        fs.writeFileSync(p, Buffer.alloc(size, 1));
        return p;
      };
      const att = (contentType: string, p: string) => ({ contentType, path: p });
      const spec = (title: string, status: string, results: unknown[], projectName = "chromium") => ({
        title,
        tests: [{ status, projectName, results }],
      });
      const r = {
        suites: [
          {
            title: "smoke.spec.ts",
            specs: [
              spec("a passes", "expected", [
                { status: "passed", attachments: [att("image/png", write("a.png", 10)), att("video/webm", write("a.webm", 30)), att("application/zip", write("a.zip", 10))] },
              ]),
              spec("b flaky", "flaky", [
                { status: "failed", attachments: [att("image/png", write("b-fail.png", 10)), att("application/zip", write("b.zip", 10))] },
                { status: "passed", attachments: [att("image/png", write("b-pass.png", 10))] },
              ]),
              spec("c fails", "unexpected", [{ status: "timedOut", attachments: [att("video/webm", write("c.webm", 20)), att("image/png", write("c.png", 10))] }]),
              spec("login", "expected", [{ status: "passed", attachments: [att("image/png", write("setup.png", 10))] }], "setup"),
            ],
          },
        ],
      };
      const all = selectRunAttachments(r, root, {
        maxFiles: 20,
        maxBytesPerFile: 100,
        passing: { screenshot: true, video: true },
      });
      expect(all.map((a) => [a.name, a.resultStatus])).toEqual([
        ["b-fail.png", "failed"],
        ["c.png", "timedOut"],
        ["c.webm", "timedOut"],
        ["b.zip", "failed"],
        ["a.png", "passed"],
        ["a.webm", "passed"],
      ]);
      expect(selectRunAttachments(r, root, { maxFiles: 20, maxBytesPerFile: 100 }).map((a) => a.name)).toEqual([
        "b-fail.png",
        "c.png",
        "c.webm",
        "b.zip",
      ]);
      // c.webm (20 bytes) no longer fits after the two screenshots; smaller files still do.
      expect(
        selectRunAttachments(r, root, { maxFiles: 20, maxBytesPerFile: 100, maxTotalBytes: 35 }).map((a) => a.name),
      ).toEqual(["b-fail.png", "c.png", "b.zip"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
