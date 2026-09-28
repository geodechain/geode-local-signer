/**
 * Codec between agent-facing JSON and contract SCALE bytes (plan §3.3).
 *
 * Inputs are validated strictly here, before anything reaches the chain. Text is always encoded
 * as UTF-8 bytes by us, never handed to a library that might treat a "0x…" string as hex.
 */
import { checkAddress, decodeAddress, encodeAddress } from "@polkadot/util-crypto";

import { LIMITS, ScaleReader, ScaleWriter } from "./scale.ts";
import { findForbiddenChar, stripHidden, toHex, tryUtf8, utf8Bytes } from "./text.ts";
import type { AbiTypes, TypeDef } from "./abiTypes.ts";
import type { ArgDef, ArgKind, ToolDef } from "./types.ts";

export class CodecError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

export interface ChainFormat {
  /** SS58 prefix used when rendering addresses in outputs. */
  outputSs58Prefix: number;
  /** SS58 prefixes accepted on input (the chain's own prefix and the generic 42). */
  acceptedSs58Prefixes: readonly number[];
  /** Token decimals (from chain properties). */
  decimals: number;
}

export const MAX_ACCOUNT_LIST = 50;

// ---------------------------------------------------------------------------------------------
// Input validation + encoding
// ---------------------------------------------------------------------------------------------

function parseText(field: string, v: unknown, maxBytes: number): Uint8Array {
  if (typeof v !== "string") throw new CodecError(field, "must be a string");
  if (!v.isWellFormed()) throw new CodecError(field, "contains unpaired surrogate characters");
  const bad = findForbiddenChar(v);
  if (bad !== undefined) throw new CodecError(field, `contains a forbidden control or invisible character (${bad})`);
  const bytes = utf8Bytes(v);
  if (bytes.length > maxBytes) throw new CodecError(field, `is ${bytes.length} bytes; the maximum is ${maxBytes}`);
  return bytes;
}

function parseUrl(field: string, v: unknown, maxBytes: number): Uint8Array {
  const bytes = parseText(field, v, maxBytes);
  const s = v as string;
  if (s === "") return bytes;
  if (/\s/.test(s)) throw new CodecError(field, "must not contain whitespace");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new CodecError(field, "must be a valid https:// URL or an empty string");
  }
  if (url.protocol !== "https:" || url.hostname === "") {
    throw new CodecError(field, "must be an https:// URL or an empty string");
  }
  return bytes;
}

export function parseAccountId(field: string, v: unknown, fmt: ChainFormat): Uint8Array {
  if (typeof v !== "string" || v.startsWith("0x")) throw new CodecError(field, "must be an SS58 address");
  const ok = fmt.acceptedSs58Prefixes.some((p) => checkAddress(v, p)[0]);
  if (!ok) {
    throw new CodecError(field, `is not a valid address for this chain (accepted SS58 prefixes: ${fmt.acceptedSs58Prefixes.join(", ")})`);
  }
  return decodeAddress(v);
}

export function parseBalance(field: string, v: unknown, decimals: number): bigint {
  let raw: bigint;
  if (typeof v === "string") {
    const parts = v.split(".");
    const whole = parts[0] ?? "";
    const frac = parts[1] ?? "";
    if (parts.length > 2 || !/^\d{1,39}$/.test(whole) || (parts.length === 2 && !/^\d{1,64}$/.test(frac))) {
      throw new CodecError(field, 'must be a decimal GEODE amount such as "1.25"');
    }
    if (frac.length > decimals) throw new CodecError(field, `has more than ${decimals} decimal places`);
    raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  } else if (typeof v === "object" && v !== null && Object.keys(v).length === 1 && "raw" in v) {
    const r = (v as { raw: unknown }).raw;
    if (typeof r !== "string" || !/^\d{1,39}$/.test(r)) throw new CodecError(field, "raw must be a string of digits");
    raw = BigInt(r);
  } else {
    throw new CodecError(field, 'must be a decimal GEODE string ("1.25") or {"raw": "<planck>"}');
  }
  if (raw > LIMITS.U128_MAX) throw new CodecError(field, "exceeds the maximum balance");
  return raw;
}

function parseUintString(field: string, v: unknown, max: bigint): bigint {
  if (typeof v !== "string" || !/^\d{1,39}$/.test(v)) throw new CodecError(field, "must be a string of digits");
  const n = BigInt(v);
  if (n > max) throw new CodecError(field, `exceeds the maximum ${max}`);
  return n;
}

function parseHash(field: string, v: unknown): Uint8Array {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new CodecError(field, "must be a 0x-prefixed 32-byte hex hash");
  return Uint8Array.from(Buffer.from(v.slice(2), "hex"));
}

/** Validate one agent-supplied value and append its SCALE encoding. */
export function encodeArg(w: ScaleWriter, field: string, kind: ArgKind, v: unknown, arg: Pick<ArgDef, "maxBytes">, fmt: ChainFormat): void {
  switch (kind) {
    case "text":
      w.vecU8(parseText(field, v, arg.maxBytes ?? 512));
      return;
    case "url":
      w.vecU8(parseUrl(field, v, arg.maxBytes ?? 512));
      return;
    case "accountId":
      w.bytes(parseAccountId(field, v, fmt));
      return;
    case "accountIdList": {
      if (!Array.isArray(v)) throw new CodecError(field, "must be an array of addresses");
      if (v.length > MAX_ACCOUNT_LIST) throw new CodecError(field, `has more than ${MAX_ACCOUNT_LIST} addresses`);
      w.compactLength(v.length);
      v.forEach((a, i) => w.bytes(parseAccountId(`${field}[${i}]`, a, fmt)));
      return;
    }
    case "balance":
      w.u128(parseBalance(field, v, fmt.decimals));
      return;
    case "hash":
      w.bytes(parseHash(field, v));
      return;
    case "bool":
      if (typeof v !== "boolean") throw new CodecError(field, "must be true or false");
      w.bool(v);
      return;
    case "u8":
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) throw new CodecError(field, "must be an integer 0–255");
      w.u8(v);
      return;
    case "u64":
      w.u64(parseUintString(field, v, LIMITS.U64_MAX));
      return;
    case "u128":
      w.u128(parseUintString(field, v, LIMITS.U128_MAX));
      return;
  }
}

/**
 * Build the contract call data: selector ++ SCALE(args), in ABI order.
 * `serverArg` supplies values for arguments the server fills itself (e.g. survey ip_address).
 */
export function encodeCall(
  tool: ToolDef,
  input: Record<string, unknown>,
  fmt: ChainFormat,
  serverArg?: (arg: ArgDef, input: Record<string, unknown>) => Uint8Array,
): Uint8Array {
  const allowed = new Set(tool.args.map((a) => (a.source === "agent" ? a.abiName : a.input?.name)).filter(Boolean));
  for (const k of Object.keys(input)) {
    if (!allowed.has(k)) throw new CodecError(k, "is not an argument of this tool");
  }

  const w = new ScaleWriter().bytes(Uint8Array.from(Buffer.from(tool.selector.slice(2), "hex")));
  for (const arg of tool.args) {
    if (arg.source === "agent") {
      if (!Object.hasOwn(input, arg.abiName)) throw new CodecError(arg.abiName, "is required");
      encodeArg(w, arg.abiName, arg.kind, input[arg.abiName], arg, fmt);
    } else {
      if (serverArg === undefined) throw new CodecError(arg.abiName, "is filled by the server but no provider was given");
      if (arg.input !== undefined && !Object.hasOwn(input, arg.input.name)) throw new CodecError(arg.input.name, "is required");
      w.vecU8(serverArg(arg, input));
    }
  }
  return w.toU8a();
}

// ---------------------------------------------------------------------------------------------
// Output decoding (driven by the ABI type registry)
// ---------------------------------------------------------------------------------------------

const TIMESTAMP_FIELDS = new Set(["timestamp", "member_since", "last_update", "order_timestamp", "time_delivered"]);
const ACCOUNT_ID_PATH = "ink_primitives::types::AccountId";
const HASH_PATH = "ink_primitives::types::Hash";

export function formatBalance(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function pathOf(t: TypeDef): string {
  return (t.path ?? []).join("::");
}

interface Hint {
  fieldName?: string | undefined;
  typeName?: string | undefined;
}

class Decoder {
  private readonly minSizeCache = new Map<number, number>();
  private readonly types: AbiTypes;
  private readonly fmt: ChainFormat;

  constructor(types: AbiTypes, fmt: ChainFormat) {
    this.types = types;
    this.fmt = fmt;
  }

  private type(id: number): TypeDef {
    const t = this.types.get(id);
    if (t === undefined) throw new Error(`ABI: unknown type id ${id}`);
    return t;
  }

  /** Smallest possible encoding of a type, used to bound sequence lengths. */
  minSize(id: number, depth = 0): number {
    const cached = this.minSizeCache.get(id);
    if (cached !== undefined) return cached;
    if (depth > 64) return 0;
    const d = this.type(id).def;
    let size = 0;
    if (d.primitive !== undefined) size = { bool: 1, u8: 1, u16: 2, u32: 4, u64: 8, u128: 16 }[d.primitive] ?? 0;
    else if (d.sequence !== undefined) size = 1;
    else if (d.array !== undefined) size = d.array.len * this.minSize(d.array.type, depth + 1);
    else if (d.tuple !== undefined) size = d.tuple.reduce((n, t) => n + this.minSize(t, depth + 1), 0);
    else if (d.composite !== undefined) size = (d.composite.fields ?? []).reduce((n, f) => n + this.minSize(f.type, depth + 1), 0);
    else if (d.variant !== undefined) {
      const vs = d.variant.variants ?? [];
      size = 1 + (vs.length ? Math.min(...vs.map((v) => (v.fields ?? []).reduce((n, f) => n + this.minSize(f.type, depth + 1), 0))) : 0);
    }
    this.minSizeCache.set(id, size);
    return size;
  }

  decode(id: number, r: ScaleReader, hint: Hint = {}, depth = 0): unknown {
    if (depth > 64) throw new Error("ABI: type nesting too deep");
    const t = this.type(id);
    const d = t.def;

    if (d.primitive !== undefined) {
      switch (d.primitive) {
        case "bool":
          return r.bool();
        case "u8":
          return r.u8();
        case "u16":
          return r.u16();
        case "u32":
          return r.u32();
        case "u64": {
          const v = r.u64();
          if (hint.fieldName !== undefined && TIMESTAMP_FIELDS.has(hint.fieldName)) {
            const ms = Number(v);
            const iso = Number.isSafeInteger(ms) && ms < 8.64e15 ? new Date(ms).toISOString() : null;
            return { raw: v.toString(), iso };
          }
          return v.toString();
        }
        case "u128": {
          const v = r.u128();
          if (hint.typeName === "Balance") return { raw: v.toString(), geode: formatBalance(v, this.fmt.decimals) };
          return v.toString();
        }
        default:
          throw new Error(`ABI: unsupported primitive ${d.primitive}`);
      }
    }

    if (d.sequence !== undefined) {
      const inner = this.type(d.sequence.type);
      if (inner.def.primitive === "u8") {
        const bytes = r.bytesFixed(r.compactLength(1));
        const text = tryUtf8(bytes);
        return text === undefined ? { hex: toHex(bytes) } : stripHidden(text);
      }
      const n = r.compactLength(this.minSize(d.sequence.type));
      const out: unknown[] = [];
      for (let i = 0; i < n; i++) out.push(this.decode(d.sequence.type, r, { typeName: undefined }, depth + 1));
      return out;
    }

    if (d.array !== undefined) {
      const inner = this.type(d.array.type);
      if (inner.def.primitive === "u8") return toHex(r.bytesFixed(d.array.len));
      const out: unknown[] = [];
      for (let i = 0; i < d.array.len; i++) out.push(this.decode(d.array.type, r, {}, depth + 1));
      return out;
    }

    if (d.tuple !== undefined) {
      if (d.tuple.length === 0) return null;
      return d.tuple.map((tid) => this.decode(tid, r, {}, depth + 1));
    }

    if (d.composite !== undefined) {
      const path = pathOf(t);
      if (path === ACCOUNT_ID_PATH) return encodeAddress(r.bytesFixed(32), this.fmt.outputSs58Prefix);
      if (path === HASH_PATH) return toHex(r.bytesFixed(32));
      const fields = d.composite.fields ?? [];
      if (fields.length === 0) return null;
      if (fields.every((f) => f.name !== undefined)) {
        const obj: Record<string, unknown> = {};
        for (const f of fields) obj[f.name!] = this.decode(f.type, r, { fieldName: f.name, typeName: f.typeName }, depth + 1);
        return obj;
      }
      if (fields.length === 1) return this.decode(fields[0]!.type, r, { ...hint, typeName: fields[0]!.typeName ?? hint.typeName }, depth + 1);
      return fields.map((f) => this.decode(f.type, r, { typeName: f.typeName }, depth + 1));
    }

    if (d.variant !== undefined) {
      const index = r.u8();
      const v = (d.variant.variants ?? []).find((x) => x.index === index);
      if (v === undefined) throw new Error(`ABI: unknown variant index ${index} for ${pathOf(t) || id}`);
      const fields = v.fields ?? [];
      const decodeFields = (): unknown => {
        if (fields.length === 0) return null;
        if (fields.every((f) => f.name !== undefined)) {
          const obj: Record<string, unknown> = {};
          for (const f of fields) obj[f.name!] = this.decode(f.type, r, { fieldName: f.name, typeName: f.typeName }, depth + 1);
          return obj;
        }
        if (fields.length === 1) return this.decode(fields[0]!.type, r, { typeName: fields[0]!.typeName }, depth + 1);
        return fields.map((f) => this.decode(f.type, r, { typeName: f.typeName }, depth + 1));
      };
      if (pathOf(t) === "Result") return v.name === "Ok" ? { ok: decodeFields() } : { err: decodeFields() };
      if (fields.length === 0) return v.name;
      return { [v.name]: decodeFields() };
    }

    throw new Error(`ABI: unsupported type definition for id ${id}`);
  }
}

/** Decode a complete SCALE value of ABI type `typeId`; trailing bytes are an error. */
export function decodeValue(types: AbiTypes, typeId: number, bytes: Uint8Array, fmt: ChainFormat): unknown {
  const r = new ScaleReader(bytes);
  const v = new Decoder(types, fmt).decode(typeId, r);
  r.assertDone();
  return v;
}

/** Decode a run of named fields (e.g. an ink! 5 event's args) that must consume `bytes` exactly. */
export function decodeFields(types: AbiTypes, fields: readonly { name: string; type: number; typeName?: string }[], bytes: Uint8Array, fmt: ChainFormat): Record<string, unknown> {
  const r = new ScaleReader(bytes);
  const d = new Decoder(types, fmt);
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.name] = d.decode(f.type, r, { fieldName: f.name, typeName: f.typeName });
  r.assertDone();
  return out;
}
