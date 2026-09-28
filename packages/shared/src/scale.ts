/**
 * Minimal, strict SCALE reader/writer for the subset of types used by the 8 Geode contracts:
 * bool, u8, u32, u64, u128, compact-prefixed sequences, fixed arrays, tuples, composites, variants.
 *
 * Written in-house (rather than via @polkadot/types) so that both the server and the local signer
 * decode contract data identically, exactly, and with hard bounds on untrusted input.
 */

export class ScaleError extends Error {}

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export class ScaleReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(n: number): Uint8Array {
    if (n < 0 || n > this.remaining) {
      throw new ScaleError(`SCALE: need ${n} bytes at offset ${this.offset}, have ${this.remaining}`);
    }
    const out = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  bytesFixed(n: number): Uint8Array {
    return this.take(n);
  }

  u8(): number {
    return this.take(1)[0]!;
  }

  bool(): boolean {
    const b = this.u8();
    if (b > 1) throw new ScaleError(`SCALE: invalid bool byte ${b}`);
    return b === 1;
  }

  private uintLE(n: number): bigint {
    const b = this.take(n);
    let v = 0n;
    // eslint-disable-next-line security/detect-object-injection -- numeric index into a local array
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  u16(): number {
    return Number(this.uintLE(2));
  }

  u32(): number {
    return Number(this.uintLE(4));
  }

  u64(): bigint {
    return this.uintLE(8);
  }

  u128(): bigint {
    return this.uintLE(16);
  }

  /** Compact<u32>-style length prefix. Rejects non-canonical encodings and lengths > remaining bytes. */
  compactLength(minElementBytes: number): number {
    const first = this.bytes[this.offset];
    if (first === undefined) throw new ScaleError("SCALE: missing compact prefix");
    const mode = first & 0b11;
    let value: number;
    if (mode === 0) {
      value = this.u8() >>> 2;
    } else if (mode === 1) {
      value = this.u16() >>> 2;
      if (value < 1 << 6) throw new ScaleError("SCALE: non-canonical compact");
    } else if (mode === 2) {
      value = this.u32() >>> 2;
      if (value < 1 << 14) throw new ScaleError("SCALE: non-canonical compact");
    } else {
      throw new ScaleError("SCALE: compact length too large");
    }
    // Every element needs at least minElementBytes, so a claimed length beyond that is malformed
    // (and would otherwise let a tiny payload request a huge allocation).
    if (minElementBytes > 0 && value > this.remaining / minElementBytes) {
      throw new ScaleError(`SCALE: sequence length ${value} exceeds available data`);
    }
    return value;
  }

  /** General Compact<uN> (all four modes), as used for balances, nonces and weights. */
  compactBig(): bigint {
    const first = this.u8();
    const mode = first & 0b11;
    if (mode === 0) return BigInt(first >>> 2);
    if (mode === 1) {
      const v = BigInt((first | (this.u8() << 8)) >>> 2);
      if (v < 1n << 6n) throw new ScaleError("SCALE: non-canonical compact");
      return v;
    }
    if (mode === 2) {
      const rest = this.take(3);
      const v = BigInt(((first | (rest[0]! << 8) | (rest[1]! << 16) | (rest[2]! << 24)) >>> 0) >>> 2);
      if (v < 1n << 14n) throw new ScaleError("SCALE: non-canonical compact");
      return v;
    }
    const n = (first >>> 2) + 4;
    if (n > 16) throw new ScaleError("SCALE: compact integer wider than 128 bits");
    const v = this.uintLE(n);
    if (v < 1n << 30n || (n > 4 && v < 1n << BigInt((n - 1) * 8))) throw new ScaleError("SCALE: non-canonical compact");
    return v;
  }

  assertDone(): void {
    if (this.remaining !== 0) throw new ScaleError(`SCALE: ${this.remaining} trailing bytes`);
  }
}

export class ScaleWriter {
  private readonly parts: Uint8Array[] = [];

  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }

  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new ScaleError(`u8 out of range: ${v}`);
    return this.bytes(Uint8Array.of(v));
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  private uintLE(v: bigint, n: number, max: bigint, label: string): this {
    if (v < 0n || v > max) throw new ScaleError(`${label} out of range: ${v}`);
    const out = new Uint8Array(n);
    let x = v;
    for (let i = 0; i < n; i++) {
      // eslint-disable-next-line security/detect-object-injection -- numeric index into a local array
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    return this.bytes(out);
  }

  u32(v: number): this {
    return this.uintLE(BigInt(v), 4, 0xffffffffn, "u32");
  }

  u64(v: bigint): this {
    return this.uintLE(v, 8, U64_MAX, "u64");
  }

  u128(v: bigint): this {
    return this.uintLE(v, 16, U128_MAX, "u128");
  }

  compactLength(n: number): this {
    if (!Number.isInteger(n) || n < 0 || n >= 1 << 30) throw new ScaleError(`compact length out of range: ${n}`);
    if (n < 1 << 6) return this.u8(n << 2);
    if (n < 1 << 14) {
      const v = (n << 2) | 0b01;
      return this.bytes(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff));
    }
    const v = ((n << 2) | 0b10) >>> 0;
    return this.bytes(Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff));
  }

  /** General Compact<uN> encoding. */
  compactBig(v: bigint): this {
    if (v < 0n || v > U128_MAX) throw new ScaleError(`compact out of range: ${v}`);
    if (v < 1n << 6n) return this.u8(Number(v) << 2);
    if (v < 1n << 14n) return this.compactLength(Number(v));
    if (v < 1n << 30n) return this.compactLength(Number(v));
    let n = 4;
    while (v >= 1n << BigInt(n * 8)) n++;
    this.u8(((n - 4) << 2) | 0b11);
    return this.uintLE(v, n, U128_MAX, "compact");
  }

  /** Vec<u8>: compact length + raw bytes. */
  vecU8(b: Uint8Array): this {
    return this.compactLength(b.length).bytes(b);
  }

  toU8a(): Uint8Array {
    const len = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

export const LIMITS = { U64_MAX, U128_MAX } as const;
