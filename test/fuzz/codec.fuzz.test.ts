/**
 * Property-based fuzzing of the parts that touch untrusted bytes (plan §5.1).
 *
 * Two properties are being asserted throughout:
 *   1. Round trips are lossless for anything we accept.
 *   2. Hostile or malformed input produces a *typed* error, never a crash, a hang, or — worst of
 *      all — a silently wrong value that gets signed.
 *
 * Run the long version with FUZZ_RUNS=10000 (nightly); the default keeps CI quick.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  CodecError,
  PayloadError,
  ScaleError,
  ScaleReader,
  ScaleWriter,
  decodeSigningPayload,
  findForbiddenChar,
  formatBalance,
  parseAccountId,
  parseBalance,
  stripHidden,
  type ChainFormat,
} from "../../packages/shared/src/index.ts";

const runs = Number(process.env.FUZZ_RUNS ?? 500);
const opts = { numRuns: runs } as const;

const FMT: ChainFormat = { outputSs58Prefix: 42, acceptedSs58Prefixes: [42], decimals: 12 };

describe("SCALE round trips", () => {
  it("u8/u32/u64 survive a round trip", () => {
    fc.assert(
      fc.property(fc.nat(255), fc.nat(0xffffffff), fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (a, b, c) => {
        const w = new ScaleWriter();
        w.u8(a).u32(b).u64(c);
        const r = new ScaleReader(w.toU8a());
        expect(r.u8()).toBe(a);
        expect(r.u32()).toBe(b);
        expect(r.u64()).toBe(c);
      }),
      opts,
    );
  });

  it("compact integers survive a round trip across every encoding width", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (n) => {
        const w = new ScaleWriter();
        w.compactBig(n);
        expect(new ScaleReader(w.toU8a()).compactBig()).toBe(n);
      }),
      opts,
    );
  });

  it("byte strings survive a round trip", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (bytes) => {
        const w = new ScaleWriter();
        w.vecU8(bytes);
        const r = new ScaleReader(w.toU8a());
        expect(Array.from(r.bytesFixed(r.compactLength(1)))).toEqual(Array.from(bytes));
      }),
      opts,
    );
  });

  it("never reads past the end of a buffer, whatever the bytes say", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const r = new ScaleReader(bytes);
        try {
          // Ask for far more than could possibly be there.
          r.compactBig();
          r.bytesFixed(r.compactLength(1));
          r.bytesFixed(32);
          r.u64();
        } catch (e) {
          // A truncated buffer must be a typed error, not a TypeError or a silent zero.
          expect(e).toBeInstanceOf(ScaleError);
          return;
        }
      }),
      opts,
    );
  });
});

describe("balance parsing", () => {
  it("round-trips decimal GEODE amounts through planck and back", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), (raw) => {
        const formatted = formatBalance(raw, 12);
        expect(parseBalance("amount", formatted, 12)).toBe(raw);
      }),
      opts,
    );
  });

  it("refuses anything that is not a clean non-negative decimal", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        // Whatever the string is, the outcome is a bigint or a CodecError. Nothing else.
        try {
          const v = parseBalance("amount", s, 12);
          expect(typeof v).toBe("bigint");
          expect(v >= 0n).toBe(true);
        } catch (e) {
          expect(e).toBeInstanceOf(CodecError);
        }
      }),
      opts,
    );
  });

  it("never loses precision below one planck", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (raw) => {
        // A value one planck apart must never format to the same string.
        expect(formatBalance(raw, 12)).not.toBe(formatBalance(raw + 1n, 12));
      }),
      opts,
    );
  });
});

describe("account ids", () => {
  it("rejects arbitrary strings without throwing anything untyped", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        try {
          parseAccountId("who", s, FMT);
        } catch (e) {
          expect(e).toBeInstanceOf(CodecError);
        }
      }),
      opts,
    );
  });
});

describe("text safety", () => {
  it("stripHidden output never still contains a forbidden character", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (s) => {
        expect(findForbiddenChar(stripHidden(s))).toBeUndefined();
      }),
      opts,
    );
  });

  it("flags any string containing an invisible or direction-changing character", () => {
    // Built from code points, never as literal characters: an invisible character pasted into
    // source is exactly the trojan-source problem these ranges exist to catch.
    const nasty = [0x200b, 0x200e, 0x202e, 0xfeff, 0x2066, 0x0000, 0x001b].map((c) => String.fromCodePoint(c));
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), fc.constantFrom(...nasty), fc.nat(50), (s, bad, at) => {
        const i = Math.min(at, s.length);
        const spiked = s.slice(0, i) + bad + s.slice(i);
        expect(findForbiddenChar(spiked)).toBeDefined();
      }),
      opts,
    );
  });

  it("leaves ordinary text alone", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[ -~\n\t]{0,200}$/), (s) => {
        expect(stripHidden(s)).toBe(s);
      }),
      opts,
    );
  });
});

describe("signing payload decoder", () => {
  it("never crashes, hangs or returns garbage on random bytes", () => {
    // This is the one that matters most: the local signer runs this on bytes a possibly
    // compromised server sent it, before deciding whether to sign.
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 600 }), (bytes) => {
        try {
          const decoded = decodeSigningPayload(bytes);
          // If it claims to have decoded something, the shape must be fully formed.
          expect(decoded.call.kind === "contracts.call" || decoded.call.kind === "balances.transferKeepAlive").toBe(true);
          expect(typeof decoded.genesisHash).toBe("string");
          expect(decoded.nonce >= 0n).toBe(true);
        } catch (e) {
          expect(e instanceof PayloadError || e instanceof ScaleError || e instanceof CodecError).toBe(true);
        }
      }),
      opts,
    );
  });

  it("stays typed when random bytes are appended to a plausible prefix", () => {
    // Random bytes rarely reach deep decoding paths; a valid-looking call index gets further in.
    const prefixes = ["1306", "0603", "1300", "0600"].map((h) => Uint8Array.from(Buffer.from(h, "hex")));
    fc.assert(
      fc.property(fc.constantFrom(...prefixes), fc.uint8Array({ maxLength: 400 }), (prefix, rest) => {
        const bytes = new Uint8Array([...prefix, ...rest]);
        try {
          decodeSigningPayload(bytes);
        } catch (e) {
          expect(e instanceof PayloadError || e instanceof ScaleError || e instanceof CodecError).toBe(true);
        }
      }),
      opts,
    );
  });
});
