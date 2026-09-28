/** Test accounts and chain format with no server dependency (the public signer repository uses these). */
import { encodeAddress } from "@polkadot/util-crypto";

import type { ChainFormat } from "../../packages/shared/src/index.ts";

export const FORMAT: ChainFormat = { outputSs58Prefix: 42, acceptedSs58Prefixes: [42], decimals: 12 };

/** Deterministic test accounts (public keys 0x01…01 and 0x02…02). */
export const ALICE = encodeAddress(new Uint8Array(32).fill(1), 42);
export const BOB = encodeAddress(new Uint8Array(32).fill(2), 42);
