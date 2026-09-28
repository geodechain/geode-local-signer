/** Wire-level kinds that every contract argument is mapped onto. */
export type ArgKind =
  | "text" // Vec<u8> carrying UTF-8 text
  | "url" // Vec<u8> carrying an https URL (or empty)
  | "accountId" // AccountId (SS58 on the wire)
  | "accountIdList" // Vec<AccountId>
  | "balance" // Balance (u128 planck; decimal GEODE on the wire)
  | "hash" // Hash ([u8; 32], 0x-hex on the wire)
  | "bool"
  | "u8"
  | "u64"
  | "u128";

/**
 * Where an argument's value comes from.
 * - agent: supplied by the calling agent (validated by the codec)
 * - server_agent_ip_hash: filled by the server from the authenticated agent's address
 * - server_ip_hash_of_input: filled by the server from another agent-supplied input (see `input`)
 */
export type ArgSource = "agent" | "server_agent_ip_hash" | "server_ip_hash_of_input";

export interface ArgDef {
  /** Name as it appears in the contract ABI (and on the wire, in order). */
  abiName: string;
  kind: ArgKind;
  /** Max UTF-8 byte length for text/url kinds. */
  maxBytes?: number;
  source: ArgSource;
  /** For server_ip_hash_of_input: the agent-facing input that replaces this arg. */
  input?: { name: string; kind: ArgKind };
}

export type PolicyClass = "read" | "write" | "payable" | "destructive";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDef {
  /** MCP tool name: geode_<contract slug>_<message>. */
  name: string;
  contract: string;
  message: string;
  /** Position of the message in the ABI / tool log. */
  index: number;
  /** 4-byte ink! selector, 0x-hex. */
  selector: string;
  kind: "query" | "tx";
  payable: boolean;
  classes: PolicyClass[];
  description: string;
  args: ArgDef[];
  /** Type id of the message return type in the contract's ABI type registry. */
  returnTypeId: number;
  annotations: ToolAnnotations;
}

export interface ContractDef {
  name: string;
  slug: string;
  address: string;
  /** File under abis/ holding the metadata-only ABI. */
  abiFile: string;
  /** Code hash recorded in the ABI; must equal the on-chain codeHash at startup. */
  codeHash: string;
}

export interface SkippedMessage {
  contract: string;
  message: string;
  selector: string;
}
