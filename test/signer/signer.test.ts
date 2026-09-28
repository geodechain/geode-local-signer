/**
 * The local signer on its own, with no server: what it signs, what it refuses, its own spending caps,
 * Terms signatures, and account creation. Payloads are built offline with polkadot.js and real Geode
 * metadata, exactly as the server builds them. This suite ships with the public signer repository.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Keyring } from "@polkadot/keyring";
import { hexToU8a } from "@polkadot/util";
import { cryptoWaitReady, mnemonicGenerate, signatureVerify } from "@polkadot/util-crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LocalSigner, SignerError } from "../../packages/local-signer/src/signer.ts";
import { CONTRACTS, REGISTRY_VERSION, TOOLS, encodeCall, signingMessage, termsMessage, toHex, type ToolDef } from "../../packages/shared/src/index.ts";
import { BOB, FORMAT } from "../helpers/accounts.ts";
import { buildPayload, tx } from "../helpers/polkadotOffline.ts";

const GEODE = 10n ** 12n;
const TERMS = { domain: "mcp.geodeapps.com", url: "https://geodechain.com/tos/", version: "2026-09-22", sha256: "e5be558e8c1ce09a740726f733c6d676ba8308652472da6c16a57234d84f0e6d" };

const tool = (name: string): ToolDef => TOOLS.find((t) => t.name === name)!;
const addr = (contract: string): string => CONTRACTS.find((c) => c.name === contract)!.address;
const POST = tool("geode_social_send_message_public");
const POST_ARGS = { new_message: "[MCP-TEST] hi", photo_or_youtube_link: "", website_or_document_link: "" };
const CHECKOUT = tool("geode_market_checkout_cart");

function contractCall(t: ToolDef, args: Record<string, unknown>, o: { value?: bigint; dest?: string } = {}): unknown {
  const data = encodeCall(t, args, FORMAT, () => new TextEncoder().encode("agent:test"));
  return tx.contracts.call(o.dest ?? addr(t.contract), o.value ?? 0n, { refTime: 5_000_000_000n, proofSize: 100_000n }, GEODE, toHex(data));
}

const intent = (signer: string, toolName: string, method: unknown, extra: { genesisHash?: string; immortal?: boolean } = {}) => ({
  intent_id: `it-${Math.random().toString(36).slice(2)}`,
  tool: toolName,
  signer,
  signing_payload: toHex(buildPayload({ address: signer, method, ...extra })),
});

let dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "geode-signer-test-"));
  dirs.push(d);
  return d;
}

/** A signer holding one freshly created account. */
async function withAccount(opts: { perTxGeode?: string; perDayGeode?: string; now?: () => number } = {}): Promise<{ signer: LocalSigner; address: string; dir: string }> {
  const dir = tempDir();
  const signer = await LocalSigner.create({ dir, ...opts });
  const made = signer.createAccount("agent");
  return { signer, address: made.address as string, dir };
}

beforeAll(async () => {
  await cryptoWaitReady();
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("signing a well-formed intent", () => {
  it("signs, and the signature verifies against the exact payload", async () => {
    const { signer, address } = await withAccount();
    const it1 = intent(address, POST.name, contractCall(POST, POST_ARGS));
    const r = signer.signIntent(it1);
    expect(r.ok).toBe(true);
    expect((r.verified as { args: unknown }).args).toEqual(POST_ARGS);
    const check = signatureVerify(signingMessage(hexToU8a(it1.signing_payload)), r.signature as string, address);
    expect(check.isValid).toBe(true);
  });

  it("reports what it verified: tool, contract, value and validity window", async () => {
    const { signer, address } = await withAccount();
    const r = signer.signIntent(intent(address, CHECKOUT.name, contractCall(CHECKOUT, { deliver_to_address: "digital" }, { value: 25n * GEODE })));
    expect(r.verified).toMatchObject({ tool: CHECKOUT.name, contract: "Market", value_geode: "25", valid_for_blocks: 64 });
  });
});

describe("refusals", () => {
  const refused = (f: () => unknown, why: RegExp): void => {
    expect(f).toThrow(SignerError);
    expect(f).toThrow(why);
  };

  it("refuses a payload that claims a different tool", async () => {
    const { signer, address } = await withAccount();
    refused(() => signer.signIntent(intent(address, "geode_social_follow_account", contractCall(POST, POST_ARGS))), /REFUSED/);
  });

  it("refuses another chain and a transaction that never expires", async () => {
    const { signer, address } = await withAccount();
    refused(() => signer.signIntent(intent(address, POST.name, contractCall(POST, POST_ARGS), { genesisHash: "0x" + "00".repeat(32) })), /another chain/);
    refused(() => signer.signIntent(intent(address, POST.name, contractCall(POST, POST_ARGS), { immortal: true })), /immortal/);
  });

  it("refuses a contract that is not one of Geode's", async () => {
    const { signer, address } = await withAccount();
    refused(() => signer.signIntent(intent(address, POST.name, contractCall(POST, POST_ARGS, { dest: BOB }))), /REFUSED/);
  });

  it("refuses GEODE attached to a call that takes none", async () => {
    const { signer, address } = await withAccount();
    refused(() => signer.signIntent(intent(address, POST.name, contractCall(POST, POST_ARGS, { value: 5n * GEODE }))), /REFUSED/);
  });

  it("refuses calls outside the tool set, such as a transfer that may empty the account", async () => {
    const { signer, address } = await withAccount();
    refused(() => signer.signIntent(intent(address, "geode_balances_transfer", tx.balances.transfer(BOB, GEODE))), /REFUSED/);
  });

  it("refuses a transfer unless the recipient and amount match what the agent stated", async () => {
    const { signer, address } = await withAccount();
    const t = () => intent(address, "geode_balances_transfer", tx.balances.transferKeepAlive(BOB, 5n * GEODE));
    refused(() => signer.signIntent(t()), /REFUSED/);
    refused(() => signer.signIntent(t(), { dest: BOB, amount: "6" }), /REFUSED/);
    refused(() => signer.signIntent(t(), { dest: address, amount: "5" }), /REFUSED/);
    expect(signer.signIntent(t(), { dest: BOB, amount: "5" }).ok).toBe(true);
  });

  it("refuses an account it does not hold", async () => {
    const { signer } = await withAccount();
    refused(() => signer.signIntent(intent(BOB, POST.name, contractCall(POST, POST_ARGS))), /no local account/);
  });

  it("suggests updating when the server's tool list differs, and still refuses", async () => {
    const { signer, address } = await withAccount();
    const unknown = { ...intent(address, "geode_social_follow_account", contractCall(POST, POST_ARGS)), registry_version: "ffffffffffffffff" };
    refused(() => signer.signIntent(unknown), /update your signer/);
    const same = { ...intent(address, "geode_social_follow_account", contractCall(POST, POST_ARGS)), registry_version: REGISTRY_VERSION };
    expect(() => signer.signIntent(same)).toThrow(SignerError);
    expect(() => signer.signIntent(same)).not.toThrow(/update your signer/);
  });

  it("signs a tool it knows even when the server's tool list is newer", async () => {
    const { signer, address } = await withAccount();
    expect(signer.signIntent({ ...intent(address, POST.name, contractCall(POST, POST_ARGS)), registry_version: "ffffffffffffffff" }).ok).toBe(true);
  });

  it("refuses garbage instead of signing it", async () => {
    const { signer, address } = await withAccount();
    refused(() => signer.signIntent({ intent_id: "x", tool: POST.name, signer: address, signing_payload: "0xdeadbeef" }), /REFUSED/);
    refused(() => signer.signIntent({ intent_id: "x", tool: POST.name, signer: address, signing_payload: "not hex" }), /hex/);
  });
});

describe("the signer's own spending caps", () => {
  it("refuses a single payment over its per-transaction cap", async () => {
    const { signer, address } = await withAccount({ perTxGeode: "10" });
    expect(() => signer.signIntent(intent(address, CHECKOUT.name, contractCall(CHECKOUT, { deliver_to_address: "d" }, { value: 11n * GEODE })))).toThrow(/REFUSED/);
    expect(signer.signIntent(intent(address, CHECKOUT.name, contractCall(CHECKOUT, { deliver_to_address: "d" }, { value: 10n * GEODE }))).ok).toBe(true);
  });

  it("counts what it has signed over a rolling 24 hours, and forgets it after", async () => {
    let now = Date.parse("2026-09-28T12:00:00Z");
    const { signer, address } = await withAccount({ perTxGeode: "10", perDayGeode: "15", now: () => now });
    const pay = (n: bigint) => intent(address, CHECKOUT.name, contractCall(CHECKOUT, { deliver_to_address: "d" }, { value: n * GEODE }));
    expect(signer.signIntent(pay(10n)).ok).toBe(true);
    expect(() => signer.signIntent(pay(6n))).toThrow(/24-hour cap/);
    expect(signer.signIntent(pay(5n)).ok).toBe(true);
    now += 24 * 3600_000 + 1;
    expect(signer.signIntent(pay(10n)).ok).toBe(true);
  });

  it("does not count calls that send no GEODE", async () => {
    const { signer, address } = await withAccount({ perDayGeode: "1" });
    for (let i = 0; i < 3; i++) expect(signer.signIntent(intent(address, POST.name, contractCall(POST, POST_ARGS))).ok).toBe(true);
  });
});

describe("Terms of Use", () => {
  it("signs a statement naming the Terms version and domain, verifiable by anyone", async () => {
    const { signer, address } = await withAccount();
    const s = signer.acceptTerms(TERMS, "agent");
    expect(s.signer).toBe(address);
    expect(s.statement).toContain(TERMS.version);
    expect(s.statement).toContain(TERMS.domain);
    expect(signatureVerify(termsMessage(s.statement), s.signature, address).isValid).toBe(true);
  });

  it("cannot be replayed as a transaction: the statement is wrapped before signing", async () => {
    const { signer } = await withAccount();
    const s = signer.acceptTerms(TERMS, "agent");
    expect(new TextDecoder().decode(termsMessage(s.statement)).startsWith("<Bytes>")).toBe(true);
  });
});

describe("accounts", () => {
  it("creates an account without ever returning a secret", async () => {
    const dir = tempDir();
    const signer = await LocalSigner.create({ dir });
    const made = signer.createAccount("my-agent");
    const text = JSON.stringify(made);
    const files = made.files as Record<string, string>;
    const phrase = readFileSync(files.recovery_phrase_backup!, "utf8");
    const password = readFileSync(files.password!, "utf8");
    // The file explains itself, then gives the phrase alone on one line.
    const line = phrase.split("\n").find((l) => { const w = l.trim().split(" "); return w.length === 24 && w.every((x) => /^[a-z]+$/.test(x)); });
    expect(line).toBeDefined();
    const words = line!.trim().split(" ");
    expect(text).not.toContain(line!.trim());
    for (let i = 0; i + 3 <= words.length; i++) expect(text).not.toContain(words.slice(i, i + 3).join(" "));
    expect(text).not.toContain(password.trim());
  });

  it("writes every file readable by its owner only", async () => {
    const dir = tempDir();
    const signer = await LocalSigner.create({ dir });
    signer.createAccount("my-agent");
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o077).toBe(0);
  });

  it("rejects bad or duplicate names and stops at its daily creation limit", async () => {
    const dir = tempDir();
    const signer = await LocalSigner.create({ dir, createAccountDailyLimit: 2 });
    expect(() => signer.createAccount("../escape")).toThrow(SignerError);
    signer.createAccount("one");
    expect(() => signer.createAccount("one")).toThrow(/already exists/);
    signer.createAccount("two");
    expect(() => signer.createAccount("three")).toThrow(/limit/);
  });

  it("uses an existing keystore once its password file sits beside it", async () => {
    const dir = tempDir();
    const pair = new Keyring({ type: "sr25519", ss58Format: 42 }).addFromUri(mnemonicGenerate(12), { name: "imported" });
    writeFileSync(join(dir, `${pair.address}.json`), JSON.stringify(pair.toJson("correct horse")), { mode: 0o600 });
    const signer = await LocalSigner.create({ dir });
    expect(signer.listAccounts()).toEqual([{ name: "imported", address: pair.address, ready: false, active: true }]);
    expect(() => signer.acceptTerms(TERMS, "imported")).toThrow(/no password file/);

    writeFileSync(join(dir, "imported-password.txt"), "wrong\n", { mode: 0o600 });
    expect(() => signer.acceptTerms(TERMS, "imported")).toThrow(/does not unlock/);

    writeFileSync(join(dir, "imported-password.txt"), "correct horse\n", { mode: 0o600 });
    expect(signer.acceptTerms(TERMS, "imported").signer).toBe(pair.address);
  });
});
