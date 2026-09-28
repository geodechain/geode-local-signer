/** Loads the ABI type registries (abis/*.json) used to decode contract return values. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { CONTRACTS } from "./generated/registry.ts";

export interface TypeField {
  name?: string;
  type: number;
  typeName?: string;
}

export interface TypeDef {
  path?: string[];
  def: {
    primitive?: string;
    sequence?: { type: number };
    array?: { len: number; type: number };
    tuple?: number[];
    composite?: { fields?: TypeField[] };
    variant?: { variants?: { name: string; index: number; fields?: TypeField[] }[] };
  };
}

export type AbiTypes = ReadonlyMap<number, TypeDef>;

/** abis/ at the repo root, overridable for deployed layouts. */
export function abiDir(): string {
  return process.env.GEODE_MCP_ABI_DIR ?? fileURLToPath(new URL("../../../abis/", import.meta.url));
}

const cache = new Map<string, AbiTypes>();

export function abiTypesFor(contract: string): AbiTypes {
  const hit = cache.get(contract);
  if (hit !== undefined) return hit;
  const c = CONTRACTS.find((x) => x.name === contract);
  if (c === undefined) throw new Error(`unknown contract ${contract}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- file name comes from the generated registry
  const raw = JSON.parse(readFileSync(join(abiDir(), c.abiFile), "utf8")) as {
    source: { hash: string };
    types: { id: number; type: TypeDef }[];
  };
  if (raw.source.hash !== c.codeHash) throw new Error(`${c.abiFile}: code hash does not match the registry`);
  const types: AbiTypes = new Map(raw.types.map((t) => [t.id, t.type]));
  cache.set(contract, types);
  return types;
}
