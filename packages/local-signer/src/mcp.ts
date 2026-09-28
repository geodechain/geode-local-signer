/**
 * geode-local-signer as a stdio MCP server. The agent adds it next to the remote geode-mcp server.
 * No tool here ever returns a password, recovery phrase or private key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SignerError, type LocalSigner } from "./signer.ts";
import { SIGNER_VERSION } from "./version.ts";

const intentSchema = z
  .object({
    intent_id: z.string(),
    tool: z.string(),
    signer: z.string(),
    signing_payload: z.string(),
  })
  .passthrough()
  .describe("The intent object returned by a geode-mcp write tool (intent_id, tool, signer, signing_payload)");

const expectSchema = z
  .object({ dest: z.string(), amount: z.string() })
  .strict()
  .optional()
  .describe("Coin transfers only: restate the recipient address and amount (GEODE) you intend to send");

const termsSchema = z
  .object({ domain: z.string(), url: z.string(), version: z.string(), sha256: z.string() })
  .passthrough()
  .describe("The `terms` object from geode-mcp (geode_agent_status or a terms_acceptance_required error)");

function result(payload: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload, isError };
}

async function guard(fn: () => Promise<Record<string, unknown>> | Record<string, unknown>): Promise<CallToolResult> {
  try {
    return result(await fn());
  } catch (e) {
    if (e instanceof SignerError) return result({ ok: false, error: e.message }, true);
    return result({ ok: false, error: "the signer failed unexpectedly" }, true);
  }
}

export async function callRemote(serverUrl: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = new Client({ name: "geode-local-signer", version: SIGNER_VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    return (r.structuredContent as Record<string, unknown> | undefined) ?? { ok: false, error: "no structured result from server" };
  } finally {
    await client.close();
  }
}

export function createSignerMcp(signer: LocalSigner, serverUrl: string | undefined): McpServer {
  const server = new McpServer(
    { name: "geode-local-signer", version: SIGNER_VERSION },
    {
      instructions:
        "Signs Geode transactions on this machine. It independently decodes and checks every intent from geode-mcp before signing, and refuses anything that is not the exact allowed call. Keys, passwords and recovery phrases never leave this machine and are never shown.",
    },
  );
  const noServer = (): never => {
    throw new SignerError("no geode-mcp server URL configured (start the signer with --server <url>)");
  };

  server.registerTool(
    "list_accounts",
    { description: "List the accounts this signer holds (name, address, whether its password file is present). Never shows secrets.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => guard(() => ({ ok: true, accounts: signer.listAccounts() })),
  );

  server.registerTool(
    "use_account",
    { description: "Choose the default account (by name or address) for accept_terms.", inputSchema: { account: z.string() }, annotations: { readOnlyHint: false } },
    async ({ account }: { account: string }) => guard(() => ({ ok: true, active: signer.useAccount(account) })),
  );

  server.registerTool(
    "sign_intent",
    {
      description:
        "Independently verify a geode-mcp intent and sign it. Refuses anything that is not the allowed Geode call it claims to be (wrong contract, message, chain, value, or a transfer that does not match `expect`). Returns the signature for geode_submit_intent.",
      inputSchema: { intent: intentSchema, expect: expectSchema },
    },
    async ({ intent, expect }: { intent: { intent_id: string; tool: string; signer: string; signing_payload: string }; expect?: { dest: string; amount: string } }) =>
      guard(() => signer.signIntent(intent, expect)),
  );

  server.registerTool(
    "sign_and_submit",
    {
      description: "Verify and sign a geode-mcp intent (same checks as sign_intent), then submit it to geode-mcp and return the on-chain result.",
      inputSchema: { intent: intentSchema, expect: expectSchema },
    },
    async ({ intent, expect }: { intent: { intent_id: string; tool: string; signer: string; signing_payload: string }; expect?: { dest: string; amount: string } }) =>
      guard(async () => {
        const url = serverUrl ?? noServer();
        const signed = signer.signIntent(intent, expect);
        const submitted = await callRemote(url, "geode_submit_intent", { intent_id: signed.intent_id, signature: signed.signature });
        return { ok: submitted.ok === true, verified: signed.verified, result: submitted };
      }),
  );

  server.registerTool(
    "accept_terms",
    {
      description:
        "Sign your acceptance of geode-mcp's current Terms of Use (once per Terms version, before your first write) and, by default, record it with the server.",
      inputSchema: {
        terms: termsSchema,
        account: z.string().optional().describe("Account name or address (defaults to the active account)"),
        submit: z.boolean().optional().describe("Also record it with geode-mcp (default true)"),
      },
    },
    async ({ terms, account, submit }: { terms: { domain: string; url: string; version: string; sha256: string }; account?: string; submit?: boolean }) =>
      guard(async () => {
        const signed = signer.acceptTerms({ domain: terms.domain, url: terms.url, version: terms.version, sha256: terms.sha256 }, account);
        if (submit === false) return { ok: true, ...signed };
        const url = serverUrl ?? noServer();
        const recorded = await callRemote(url, "geode_accept_terms", { signer: signed.signer, timestamp: signed.timestamp, signature: signed.signature });
        return { ok: recorded.ok === true, statement: signed.statement, result: recorded };
      }),
  );

  server.registerTool(
    "create_account",
    {
      description:
        "Create a new Geode account on this machine. Returns only its address and file locations; the recovery phrase is written to a local file for the owner to move offline and is never shown.",
      inputSchema: { name: z.string().describe("A short name for the account") },
    },
    async ({ name }: { name: string }) => guard(() => signer.createAccount(name)),
  );

  return server;
}
