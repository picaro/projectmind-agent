import { describe, expect, it } from "vitest";
import { parseStackContainers, stackNetworkName } from "./stack.ts";

describe("apply_stack payload", () => {
  const installationId = "11111111-1111-4111-8111-111111111111";

  it("builds a deterministic private network name", () => {
    expect(stackNetworkName(installationId)).toBe("pn-net-11111111-1111-4111-8111-111111111111");
  });

  it("parses sidecar + primary containers", () => {
    const digest = "sha256:" + "a".repeat(64);
    const parsed = parseStackContainers([
      {
        role: "postgres",
        imageDigest: digest,
        containerPort: 5432,
        publishLoopback: false,
        volumeSpecs: [{ name: "pg-data" }],
      },
      {
        role: "primary",
        imageDigest: digest,
        containerPort: 8055,
        publishLoopback: true,
      },
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.publishLoopback).toBe(false);
    expect(parsed[1]?.publishLoopback).toBe(true);
  });
});
