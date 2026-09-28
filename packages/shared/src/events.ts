/**
 * Decoding ink! 5 contract events (ContractEmitted).
 *
 * Lesson from wGEODE bug #8: Geode puts a zero at topics[0] and the real signature topic later, so the
 * event is identified by matching its signature topic against ALL of the record's topics. ink! 5
 * encodes every field (indexed ones included) in the event data.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { abiDir, abiTypesFor } from "./abiTypes.ts";
import { decodeFields, type ChainFormat } from "./codec.ts";
import { CONTRACTS } from "./generated/registry.ts";
import { toHex } from "./text.ts";

interface AbiEvent {
  label: string;
  signature_topic: string | null;
  args: { label: string; type: { type: number; displayName?: string[] } }[];
}

const eventCache = new Map<string, AbiEvent[]>();

function eventsFor(contract: string): AbiEvent[] {
  const hit = eventCache.get(contract);
  if (hit !== undefined) return hit;
  const c = CONTRACTS.find((x) => x.name === contract)!;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file name comes from the generated registry
  const raw = JSON.parse(readFileSync(join(abiDir(), c.abiFile), "utf8")) as { spec: { events: AbiEvent[] } };
  eventCache.set(contract, raw.spec.events);
  return raw.spec.events;
}

export interface DecodedEvent {
  contract: string;
  event: string | null;
  fields?: Record<string, unknown>;
  raw?: { topics: string[]; data: string };
}

export function decodeContractEvent(contractAddress: string, topics: readonly string[], data: Uint8Array, fmt: ChainFormat): DecodedEvent {
  const c = CONTRACTS.find((x) => x.address === contractAddress);
  if (c === undefined) return { contract: contractAddress, event: null, raw: { topics: [...topics], data: toHex(data) } };
  const lowered = topics.map((t) => t.toLowerCase());
  const ev = eventsFor(c.name).find((e) => e.signature_topic !== null && lowered.includes(e.signature_topic.toLowerCase()));
  if (ev === undefined) return { contract: c.name, event: null, raw: { topics: [...topics], data: toHex(data) } };
  try {
    const fields = decodeFields(
      abiTypesFor(c.name),
      ev.args.map((a) => ({ name: a.label, type: a.type.type, typeName: a.type.displayName?.join("::") })),
      data,
      fmt,
    );
    return { contract: c.name, event: ev.label, fields };
  } catch {
    return { contract: c.name, event: ev.label, raw: { topics: [...topics], data: toHex(data) } };
  }
}
