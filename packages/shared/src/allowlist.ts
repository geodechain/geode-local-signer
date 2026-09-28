/**
 * Runtime call allowlist, layer 3 of SKIP enforcement (plan §3.4).
 * Used by the server (intent build + submit) and by the local signer (before signing).
 */
import { CONTRACTS, SKIPPED, TOOLS } from "./generated/registry.ts";
import type { ToolDef } from "./types.ts";

const addressByContract = new Map(CONTRACTS.map((c) => [c.name, c.address]));

const key = (address: string, selector: string): string => `${address}:${selector.toLowerCase()}`;

const allowed = new Map<string, ToolDef>();
for (const t of TOOLS) {
  const address = addressByContract.get(t.contract);
  if (address === undefined) throw new Error(`registry: tool ${t.name} references unknown contract ${t.contract}`);
  allowed.set(key(address, t.selector), t);
}

const denied = new Set<string>();
for (const s of SKIPPED) {
  const address = addressByContract.get(s.contract);
  if (address === undefined) throw new Error(`registry: skipped ${s.message} references unknown contract ${s.contract}`);
  denied.add(key(address, s.selector));
}

for (const k of denied) {
  if (allowed.has(k)) throw new Error(`registry: selector ${k} is both allowed and skipped`);
}

/** The tool for a (contract address, selector) pair, or undefined if the call is not allowed. */
export function allowedContractCall(address: string, selector: string): ToolDef | undefined {
  const k = key(address, selector);
  if (denied.has(k)) return undefined;
  return allowed.get(k);
}

export const CONTRACT_ADDRESSES: ReadonlySet<string> = new Set(addressByContract.values());
