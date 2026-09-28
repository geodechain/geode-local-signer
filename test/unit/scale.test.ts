import { describe, expect, it } from "vitest";

import { ScaleError, ScaleReader, ScaleWriter } from "../../packages/shared/src/index.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

describe("SCALE compact lengths", () => {
  it.each([
    [0, "00"],
    [1, "04"],
    [63, "fc"],
    [64, "0101"],
    [16383, "fdff"],
    [16384, "02000100"],
    [(1 << 30) - 1, "feffffff"],
  ])("encodes %i canonically and reads it back", (n, expected) => {
    const bytes = new ScaleWriter().compactLength(n).toU8a();
    expect(hex(bytes)).toBe(expected);
    expect(new ScaleReader(bytes).compactLength(0)).toBe(n);
  });

  it("rejects non-canonical encodings", () => {
    expect(() => new ScaleReader(Uint8Array.from([0x01, 0x00])).compactLength(0)).toThrow(ScaleError); // 0 in 2-byte mode
    expect(() => new ScaleReader(Uint8Array.from([0x02, 0x00, 0x00, 0x00])).compactLength(0)).toThrow(ScaleError);
  });

  it("rejects big-integer mode and oversize writes", () => {
    expect(() => new ScaleReader(Uint8Array.from([0x03, 0, 0, 0, 0])).compactLength(0)).toThrow(/too large/);
    expect(() => new ScaleWriter().compactLength(1 << 30)).toThrow(ScaleError);
  });

  it("refuses a sequence length larger than the remaining data could hold", () => {
    // Claims 1,000,000 elements of >= 32 bytes in a 4-byte buffer.
    const bytes = new ScaleWriter().compactLength(1_000_000).toU8a();
    expect(() => new ScaleReader(bytes).compactLength(32)).toThrow(/exceeds available data/);
  });
});

describe("SCALE integers and bools", () => {
  it("round-trips u64/u128 at the limits, little-endian", () => {
    const max128 = (1n << 128n) - 1n;
    const bytes = new ScaleWriter().u64(1n).u128(max128).toU8a();
    expect(hex(bytes.subarray(0, 8))).toBe("0100000000000000");
    const r = new ScaleReader(bytes);
    expect(r.u64()).toBe(1n);
    expect(r.u128()).toBe(max128);
    r.assertDone();
  });

  it("rejects out-of-range writes", () => {
    expect(() => new ScaleWriter().u128(1n << 128n)).toThrow(ScaleError);
    expect(() => new ScaleWriter().u64(-1n)).toThrow(ScaleError);
    expect(() => new ScaleWriter().u8(256)).toThrow(ScaleError);
  });

  it("treats any bool byte other than 0/1 as malformed", () => {
    expect(new ScaleReader(Uint8Array.of(1)).bool()).toBe(true);
    expect(() => new ScaleReader(Uint8Array.of(2)).bool()).toThrow(/invalid bool/);
  });

  it("errors on truncated input and trailing bytes", () => {
    expect(() => new ScaleReader(Uint8Array.of(1, 2)).u32()).toThrow(/need 4 bytes/);
    const r = new ScaleReader(Uint8Array.of(1, 2));
    r.u8();
    expect(() => r.assertDone()).toThrow(/trailing/);
  });
});
