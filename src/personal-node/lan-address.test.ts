import { describe, expect, it } from "vitest";

import { selectLanAddress, type LanNic } from "./lan-address.js";

function nic(address: string, family: string | number = "IPv4", internal = false): LanNic {
  return { address, family, internal };
}

describe("selectLanAddress", () => {
  it("picks the private address on en0", () => {
    expect(
      selectLanAddress({
        lo0: [nic("127.0.0.1", "IPv4", true)],
        utun0: [nic("10.8.0.2")],
        awdl0: [nic("192.168.99.1")],
        bridge0: [nic("172.17.0.1")],
        en0: [nic("192.168.1.20"), nic("fe80::1", "IPv6")],
      }),
    ).toBe("192.168.1.20");
  });

  it("prefers a private address over a public address on a lower interface", () => {
    expect(
      selectLanAddress({
        en0: [nic("8.8.8.8")],
        en1: [nic("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
  });

  it("prefers en0 when several private addresses exist", () => {
    expect(
      selectLanAddress({
        en1: [nic("10.0.0.5")],
        en0: [nic("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
  });

  it("skips link-local, loopback, and a missing map", () => {
    expect(selectLanAddress({ en0: [nic("169.254.1.10"), nic("127.0.0.1")] })).toBeNull();
    expect(selectLanAddress(null)).toBeNull();
    expect(selectLanAddress({})).toBeNull();
  });

  it("accepts the numeric IPv4 family", () => {
    expect(selectLanAddress({ eth0: [nic("10.1.2.3", 4)] })).toBe("10.1.2.3");
  });
});
