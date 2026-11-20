import { describe, expect, it, vi } from "vitest";
import { createHttpRelaySupervisor } from "./http-relay.js";

describe("createHttpRelaySupervisor", () => {
  it("does not spawn when disabled or when spawn is not explicitly allowed", () => {
    const spawn = vi.fn();
    const supervisor = createHttpRelaySupervisor({ spawn });
    expect(supervisor.start({ enabled: false, argv: ["frpc"] })).toEqual({
      started: false,
      reason: "disabled",
    });
    expect(supervisor.start({ enabled: true, argv: ["frpc"] })).toEqual({
      started: false,
      reason: "spawn_not_allowed",
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});
