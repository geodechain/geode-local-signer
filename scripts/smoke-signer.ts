/**
 * Starts a built signer the way an agent does (stdio MCP) and checks it end to end, offline:
 * its tools, account creation (no secret in any output), and a Terms signature.
 *
 *   node scripts/smoke-signer.ts dist/geode-local-signer.mjs
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { signatureVerify, cryptoWaitReady } from "@polkadot/util-crypto";

import { termsMessage } from "../packages/shared/src/index.ts";

const bundle = process.argv[2] ?? "dist/geode-local-signer.mjs";
const dir = mkdtempSync(join(tmpdir(), "geode-signer-smoke-"));
const fail = (m: string): never => {
  throw new Error(`smoke test failed: ${m}`);
};

try {
  await cryptoWaitReady();
  const client = new Client({ name: "smoke", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle, "--dir", dir], stderr: "ignore" }));
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    ((await client.callTool({ name, arguments: args })).structuredContent as Record<string, unknown> | undefined) ?? fail(`${name}: no result`);

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const want = ["accept_terms", "create_account", "list_accounts", "sign_and_submit", "sign_intent", "use_account"];
  if (JSON.stringify(tools) !== JSON.stringify(want)) fail(`tools ${tools.join(",")}`);

  const made = await call("create_account", { name: "smoke" });
  if (made.ok !== true || typeof made.address !== "string") fail("create_account");
  if (/mnemonic|recovery_phrase"\s*:\s*"[a-z]+ /i.test(JSON.stringify(made))) fail("create_account returned a secret");

  const terms = { domain: "mcp.geodeapps.com", url: "https://geodechain.com/tos/", version: "smoke", sha256: "0".repeat(64) };
  const signed = await call("accept_terms", { terms, submit: false });
  if (!signatureVerify(termsMessage(String(signed.statement)), String(signed.signature), String(made.address)).isValid) fail("terms signature does not verify");

  await client.close();
  console.log(`smoke test passed: ${tools.length} tools, account created, Terms signature verifies`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
