import { describe, expect, it } from "vitest";
import { checkLoopbackHttp, redirectTargetIsExternal, syncQuickShares } from "./quick-share.js";

function response(status: number, location?: string): Response {
  return new Response(null, { status, headers: location ? { location } : undefined });
}

describe("quick share loopback check", () => {
  it("accepts a loopback response and rejects external redirects and blocked ports", async () => {
    const ok = await checkLoopbackHttp(5173, async () => response(200));
    expect(ok).toEqual({ available: true, httpStatus: 200, failureCode: null });

    const app = await checkLoopbackHttp(5173, async () => response(404));
    expect(app.available).toBe(true);

    const localRedirect = await checkLoopbackHttp(5173, async () => response(302, "/login"));
    expect(localRedirect.available).toBe(true);

    const external = await checkLoopbackHttp(5173, async () =>
      response(302, "https://example.com/"),
    );
    expect(external).toMatchObject({ available: false, failureCode: "redirect_external" });

    const privateRedirect = await checkLoopbackHttp(5173, async () =>
      response(302, "http://192.168.1.20/"),
    );
    expect(privateRedirect.failureCode).toBe("redirect_external");

    const otherPort = await checkLoopbackHttp(5173, async () =>
      response(302, "http://127.0.0.1:5432/"),
    );
    expect(otherPort.failureCode).toBe("redirect_external");

    const database = await checkLoopbackHttp(5432, async () => response(200));
    expect(database.failureCode).toBe("sensitive_service");
    expect(redirectTargetIsExternal("http://10.0.0.5/", 5173)).toBe(true);
  });

  it("reports each desired share without a shell string", async () => {
    const reports: Array<{ targetPort: number; available: boolean; processKey: string | null }> =
      [];
    await syncQuickShares({
      list: async () => [
        { shareId: "s1", targetPort: 5173, revision: 1, approvalGeneration: 1 },
        { shareId: "s2", targetPort: 22, revision: 1, approvalGeneration: 1 },
      ],
      report: async (body) => {
        reports.push({
          targetPort: body.targetPort,
          available: body.available,
          processKey: body.processKey,
        });
      },
      check: async (port) => checkLoopbackHttp(port, async () => response(200)),
      readProcessKey: async () => "77",
    });
    expect(reports).toEqual([
      { targetPort: 5173, available: true, processKey: "77" },
      { targetPort: 22, available: false, processKey: null },
    ]);
  });
});
