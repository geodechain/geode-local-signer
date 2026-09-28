/**
 * Independent decoding and verification of transaction signing payloads (plan §2.1 step 3).
 *
 * Used by the local signer BEFORE it signs anything, and again by the server at submit. It decodes the
 * exact bytes that will be signed, using only the pinned layout in chainSpec.ts, the generated
 * registry and the ABIs, and refuses anything that is not an allowed call.
 */
import { blake2AsU8a, encodeAddress } from "@polkadot/util-crypto";

import { allowedContractCall, CONTRACT_ADDRESSES } from "./allowlist.ts";
import { GEODE_MAINNET, MAX_ERA_PERIOD } from "./chainSpec.ts";
import { formatBalance, type ChainFormat } from "./codec.ts";
import { ScaleError, ScaleReader } from "./scale.ts";
import { toHex, tryUtf8 } from "./text.ts";
import type { ArgKind, ToolDef } from "./types.ts";

export class PayloadError extends Error {}

export type DecodedCall =
  | {
      kind: "contracts.call";
      dest: string;
      value: bigint;
      gasLimit: { refTime: bigint; proofSize: bigint };
      storageDepositLimit: bigint | null;
      data: Uint8Array;
    }
  | { kind: "balances.transferKeepAlive"; dest: string; value: bigint };

export interface DecodedPayload {
  call: DecodedCall;
  era: { mortal: false } | { mortal: true; period: number; phase: number };
  nonce: bigint;
  tip: bigint;
  assetId: number | null;
  specVersion: number;
  txVersion: number;
  genesisHash: string;
  blockHash: string;
}

const hexOf = (b: Uint8Array): string => toHex(b);
const indexOf = (hex: string): [number, number] => [parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];

function readMultiAddress(r: ScaleReader): string {
  const variant = r.u8();
  if (variant !== 0) throw new PayloadError(`destination must be a plain account id (MultiAddress::Id), got variant ${variant}`);
  return encodeAddress(r.bytesFixed(32), GEODE_MAINNET.ss58Prefix);
}

export function decodeCall(r: ScaleReader): DecodedCall {
  const pallet = r.u8();
  const call = r.u8();
  const [cp, cc] = indexOf(GEODE_MAINNET.calls.contractsCall.index);
  const [bp, bc] = indexOf(GEODE_MAINNET.calls.balancesTransferKeepAlive.index);
  if (pallet === cp && call === cc) {
    const dest = readMultiAddress(r);
    const value = r.compactBig();
    const refTime = r.compactBig();
    const proofSize = r.compactBig();
    const opt = r.u8();
    if (opt > 1) throw new PayloadError("invalid Option tag for storage_deposit_limit");
    const storageDepositLimit = opt === 1 ? r.compactBig() : null;
    const data = r.bytesFixed(r.compactLength(1));
    return { kind: "contracts.call", dest, value, gasLimit: { refTime, proofSize }, storageDepositLimit, data };
  }
  if (pallet === bp && call === bc) {
    const dest = readMultiAddress(r);
    return { kind: "balances.transferKeepAlive", dest, value: r.compactBig() };
  }
  throw new PayloadError(`call 0x${pallet.toString(16).padStart(2, "0")}${call.toString(16).padStart(2, "0")} is not an allowed call`);
}

function readEra(r: ScaleReader): DecodedPayload["era"] {
  const first = r.u8();
  if (first === 0) return { mortal: false };
  const encoded = first | (r.u8() << 8);
  const period = 2 << encoded % (1 << 4);
  const quantize = Math.max(period >> 12, 1);
  const phase = (encoded >> 4) * quantize;
  return { mortal: true, period, phase };
}

/** Decode a complete v4 signing payload (call ++ extra ++ additional-signed). */
export function decodeSigningPayload(bytes: Uint8Array): DecodedPayload {
  try {
    const r = new ScaleReader(bytes);
    const call = decodeCall(r);
    const era = readEra(r);
    const nonce = r.compactBig();
    const tip = r.compactBig();
    const assetTag = r.u8();
    if (assetTag > 1) throw new PayloadError("invalid Option tag for asset id");
    const assetId = assetTag === 1 ? r.u32() : null;
    const specVersion = r.u32();
    const txVersion = r.u32();
    const genesisHash = hexOf(r.bytesFixed(32));
    const blockHash = hexOf(r.bytesFixed(32));
    r.assertDone();
    return { call, era, nonce, tip, assetId, specVersion, txVersion, genesisHash, blockHash };
  } catch (e) {
    if (e instanceof PayloadError) throw e;
    if (e instanceof ScaleError) throw new PayloadError(`malformed signing payload: ${e.message}`);
    throw e;
  }
}

/** The bytes actually signed: the payload itself, or its blake2-256 hash when longer than 256 bytes. */
export function signingMessage(payload: Uint8Array): Uint8Array {
  return payload.length > 256 ? blake2AsU8a(payload, 256) : payload;
}

// ---------------------------------------------------------------------------------------------
// Decoding contract call arguments for human/agent review
// ---------------------------------------------------------------------------------------------

function readArg(r: ScaleReader, kind: ArgKind, fmt: ChainFormat): unknown {
  switch (kind) {
    case "text":
    case "url": {
      const b = r.bytesFixed(r.compactLength(1));
      return tryUtf8(b) ?? { hex: toHex(b) };
    }
    case "accountId":
      return encodeAddress(r.bytesFixed(32), fmt.outputSs58Prefix);
    case "accountIdList": {
      const n = r.compactLength(32);
      return Array.from({ length: n }, () => encodeAddress(r.bytesFixed(32), fmt.outputSs58Prefix));
    }
    case "balance": {
      const v = r.u128();
      return { raw: v.toString(), geode: formatBalance(v, fmt.decimals) };
    }
    case "hash":
      return toHex(r.bytesFixed(32));
    case "bool":
      return r.bool();
    case "u8":
      return r.u8();
    case "u64":
      return r.u64().toString();
    case "u128":
      return r.u128().toString();
  }
}

/** Decode contract call data (selector ++ args) back into named arguments, strictly. */
export function decodeContractArgs(tool: ToolDef, data: Uint8Array, fmt: ChainFormat): Record<string, unknown> {
  if (toHex(data.subarray(0, 4)) !== tool.selector) throw new PayloadError("call data selector does not match the tool");
  try {
    const r = new ScaleReader(data.subarray(4));
    const out: Record<string, unknown> = {};
    for (const a of tool.args) out[a.abiName] = readArg(r, a.kind, fmt);
    r.assertDone();
    return out;
  } catch (e) {
    if (e instanceof ScaleError) throw new PayloadError(`call data does not match ${tool.name}'s arguments: ${e.message}`);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Policy checks
// ---------------------------------------------------------------------------------------------

export interface VerifyOptions {
  /** The tool the intent claims to be (contract calls) or "geode_balances_transfer". */
  toolName: string;
  fmt: ChainFormat;
  /** Largest value/amount allowed in one transaction, in planck. */
  maxValue: bigint;
  /** Largest storage deposit limit allowed, in planck. */
  maxStorageDeposit: bigint;
  /** For transfers: what the agent itself says it is paying. Mandatory for transfers. */
  expectTransfer?: { dest: string; amount: bigint };
}

export interface VerifiedIntent {
  payload: DecodedPayload;
  tool: ToolDef | null;
  args: Record<string, unknown> | null;
  value: bigint;
}

/** Throws PayloadError unless the payload is an allowed, well-formed call matching `toolName`. */
export function verifyPayload(bytes: Uint8Array, opts: VerifyOptions): VerifiedIntent {
  const p = decodeSigningPayload(bytes);
  if (p.genesisHash !== GEODE_MAINNET.genesisHash) throw new PayloadError(`payload is for another chain (genesis ${p.genesisHash})`);
  if (!p.era.mortal) throw new PayloadError("payload is immortal; only mortal transactions are signed");
  if (p.era.period > MAX_ERA_PERIOD) throw new PayloadError(`validity window ${p.era.period} blocks exceeds ${MAX_ERA_PERIOD}`);
  if (p.tip !== 0n) throw new PayloadError("payload carries a tip; tips are never added");
  if (p.assetId !== null) throw new PayloadError("payload pays fees in a non-native asset");

  const call = p.call;
  if (call.value > opts.maxValue) {
    throw new PayloadError(`value ${formatBalance(call.value, opts.fmt.decimals)} GEODE exceeds the per-transaction cap ${formatBalance(opts.maxValue, opts.fmt.decimals)}`);
  }

  if (call.kind === "balances.transferKeepAlive") {
    if (opts.toolName !== "geode_balances_transfer") throw new PayloadError(`payload is a coin transfer but the intent claims ${opts.toolName}`);
    const e = opts.expectTransfer;
    if (e === undefined) throw new PayloadError("a transfer can only be signed with `expect` {dest, amount} restated by the agent");
    if (call.dest !== encodeAddress(e.dest, GEODE_MAINNET.ss58Prefix) || call.value !== e.amount) {
      throw new PayloadError("transfer destination or amount does not match what the agent expects");
    }
    if (CONTRACT_ADDRESSES.has(call.dest)) throw new PayloadError("coin transfers to Geode contracts are not allowed");
    return { payload: p, tool: null, args: null, value: call.value };
  }

  if (!CONTRACT_ADDRESSES.has(call.dest)) throw new PayloadError(`destination ${call.dest} is not one of the Geode contracts`);
  const selector = toHex(call.data.subarray(0, 4));
  const tool = allowedContractCall(call.dest, selector);
  if (tool === undefined) throw new PayloadError(`selector ${selector} is not an allowed message on ${call.dest}`);
  if (tool.name !== opts.toolName) throw new PayloadError(`payload calls ${tool.name} but the intent claims ${opts.toolName}`);
  if (tool.kind !== "tx") throw new PayloadError(`${tool.name} is read-only and is never signed`);
  if (!tool.payable && call.value !== 0n) throw new PayloadError(`${tool.name} is not payable but the payload transfers value`);
  if (call.storageDepositLimit === null) throw new PayloadError("payload has no explicit storage deposit limit");
  if (call.storageDepositLimit > opts.maxStorageDeposit) {
    throw new PayloadError(`storage deposit limit ${formatBalance(call.storageDepositLimit, opts.fmt.decimals)} GEODE exceeds the cap`);
  }
  const args = decodeContractArgs(tool, call.data, opts.fmt);
  return { payload: p, tool, args, value: call.value };
}
