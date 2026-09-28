/**
 * geode-local-signer entry point (stdio MCP server).
 *
 *   node packages/local-signer/src/index.ts --dir <accounts folder> [--server <geode-mcp URL>]
 *
 * The accounts folder holds `<address>.json` keystores and `<name>-password.txt` files.
 *
 *   node packages/local-signer/src/index.ts --version
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { REGISTRY_VERSION } from "@geode-mcp/shared";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSignerMcp } from "./mcp.ts";
import { LocalSigner } from "./signer.ts";
import { SIGNER_VERSION } from "./version.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    console.log(`geode-local-signer ${SIGNER_VERSION} (tool list ${REGISTRY_VERSION})`);
    return;
  }
  const dirArg = arg("dir") ?? process.env.GEODE_SIGNER_DIR;
  if (dirArg === undefined) throw new Error("--dir <accounts folder> is required");
  const dir = resolve(dirArg.replace(/^~(?=$|\/)/, homedir()));
  const serverUrl = arg("server") ?? process.env.GEODE_MCP_URL;
  const signer = await LocalSigner.create({ dir, perTxGeode: arg("per-tx-geode"), perDayGeode: arg("per-day-geode"), maxStorageDepositGeode: arg("max-storage-deposit-geode") });
  const server = createSignerMcp(signer, serverUrl);
  await server.connect(new StdioServerTransport());
  console.error(`geode-local-signer ready: ${signer.listAccounts().length} account(s) in ${dir}`);
}

main().catch((err: unknown) => {
  console.error(`geode-local-signer failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
