/**
 * Offline polkadot.js type registry loaded with Geode mainnet metadata (runtime 20260115), used as the
 * reference implementation that our independent payload decoder is checked against.
 */
import { readFileSync } from "node:fs";

import { Metadata, TypeRegistry, expandMetadata } from "@polkadot/types";

import { GEODE_MAINNET } from "../../packages/shared/src/index.ts";

const hex = readFileSync(new URL("../fixtures/geode-metadata-20260115.hex", import.meta.url), "utf8").trim();

export const registry = new TypeRegistry();
const metadata = new Metadata(registry, hex as `0x${string}`);
registry.setMetadata(metadata, [...GEODE_MAINNET.signedExtensions]);
// Typed loosely: without @polkadot/api-augment (the public signer repository has none), createType
// returns a plain Codec.
registry.setChainProperties(registry.createType("ChainProperties", { ss58Format: 42, tokenDecimals: [12], tokenSymbol: ["GEODE"] }) as Parameters<typeof registry.setChainProperties>[0]);

const expanded = expandMetadata(registry, metadata);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const tx = expanded.tx as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const consts = expanded.consts as any;

export const SPEC = { specVersion: 20260115, transactionVersion: 2 };
export const BLOCK_HASH = "0x" + "cd".repeat(32);

export interface PayloadOpts {
  address: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  method: any;
  nonce?: number;
  tip?: number;
  period?: number;
  genesisHash?: string;
  immortal?: boolean;
  /** Defaults to the pinned runtime; set to build a payload for another (e.g. upgraded) runtime. */
  runtime?: { specVersion: number; transactionVersion: number };
}

/** Build a signing payload exactly as polkadot.js (and wallet extensions) would. */
export function buildPayload(o: PayloadOpts): Uint8Array {
  const era = o.immortal ? registry.createType("ExtrinsicEra", "0x00") : registry.createType("ExtrinsicEra", { current: 18_760_000, period: o.period ?? 64 });
  const payload = registry.createType("SignerPayload", {
    address: o.address,
    blockHash: BLOCK_HASH,
    blockNumber: 18_760_000,
    era,
    genesisHash: o.genesisHash ?? GEODE_MAINNET.genesisHash,
    method: o.method,
    nonce: o.nonce ?? 7,
    runtimeVersion: o.runtime ?? SPEC,
    signedExtensions: [...GEODE_MAINNET.signedExtensions],
    tip: o.tip ?? 0,
    version: 4,
  });
  return Uint8Array.from(Buffer.from(payload.toRaw().data.slice(2), "hex"));
}
