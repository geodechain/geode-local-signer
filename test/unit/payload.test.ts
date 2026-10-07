import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, signatureVerify } from "@polkadot/util-crypto";
import { beforeAll, describe, expect, it } from "vitest";

import {
  CONTRACTS,
  GEODE_MAINNET,
  PayloadError,
  RuntimeVersionError,
  checkRuntimeVersion,
  ScaleReader,
  ScaleWriter,
  SKIPPED,
  TOOLS,
  decodeSigningPayload,
  encodeCall,
  signingMessage,
  toHex,
  verifyPayload,
  type ToolDef,
  type VerifyOptions,
} from "../../packages/shared/src/index.ts";
import { ALICE, BOB, FORMAT } from "../helpers/accounts.ts";
import { BLOCK_HASH, SPEC, buildPayload, consts, tx } from "../helpers/polkadotOffline.ts";

const tool = (name: string): ToolDef => TOOLS.find((t) => t.name === name)!;
const addr = (contract: string): string => CONTRACTS.find((c) => c.name === contract)!.address;
const GEODE = 10n ** 12n;
const OPTS = (toolName: string, extra: Partial<VerifyOptions> = {}): VerifyOptions => ({
  toolName,
  fmt: FORMAT,
  maxValue: 1000n * GEODE,
  maxStorageDeposit: 50n * GEODE,
  ...extra,
});

function contractCall(t: ToolDef, args: Record<string, unknown>, o: { value?: bigint; sdl?: bigint | null; dest?: string } = {}) {
  const data = encodeCall(t, args, FORMAT, () => new TextEncoder().encode("agent:test"));
  // Pass Bytes as hex: polkadot.js reads a raw Uint8Array as already length-prefixed.
  return tx.contracts.call(o.dest ?? addr(t.contract), o.value ?? 0n, { refTime: 5_000_000_000n, proofSize: 100_000n }, o.sdl === undefined ? GEODE : o.sdl, toHex(data));
}

beforeAll(async () => {
  await cryptoWaitReady();
});

describe("SCALE general compact", () => {
  it.each([0n, 63n, 64n, 16383n, 16384n, (1n << 30n) - 1n, 1n << 30n, (1n << 64n) - 1n, (1n << 128n) - 1n])("round-trips %s", (v) => {
    const b = new ScaleWriter().compactBig(v).toU8a();
    const r = new ScaleReader(b);
    expect(r.compactBig()).toBe(v);
    r.assertDone();
  });
});

describe("pinned layout matches polkadot.js with real Geode metadata", () => {
  it("has the pinned call indices", () => {
    expect(Buffer.from(tx.contracts.call.callIndex).toString("hex")).toBe(GEODE_MAINNET.calls.contractsCall.index.slice(2));
    expect(Buffer.from(tx.balances.transferKeepAlive.callIndex).toString("hex")).toBe(GEODE_MAINNET.calls.balancesTransferKeepAlive.index.slice(2));
  });

  it("decodes a contracts.call payload field by field", () => {
    const t = tool("geode_social_send_message_public");
    const bytes = buildPayload({ address: ALICE, method: contractCall(t, { new_message: "[MCP-TEST] hi", photo_or_youtube_link: "", website_or_document_link: "" }), nonce: 42 });
    const p = decodeSigningPayload(bytes);
    expect(p.call.kind).toBe("contracts.call");
    if (p.call.kind !== "contracts.call") return;
    expect(p.call.dest).toBe(addr("Social"));
    expect(p.call.value).toBe(0n);
    expect(p.call.gasLimit).toEqual({ refTime: 5_000_000_000n, proofSize: 100_000n });
    expect(p.call.storageDepositLimit).toBe(GEODE);
    expect(Buffer.from(p.call.data.subarray(0, 4)).toString("hex")).toBe(t.selector.slice(2));
    expect(p.nonce).toBe(42n);
    expect(p.tip).toBe(0n);
    expect(p.assetId).toBeNull();
    expect(p.era).toMatchObject({ mortal: true, period: 64 });
    expect(p.specVersion).toBe(20260115);
    expect(p.txVersion).toBe(2);
    expect(p.genesisHash).toBe(GEODE_MAINNET.genesisHash);
    expect(p.blockHash).toBe(BLOCK_HASH);
  });

  it("decodes a transfer_keep_alive payload", () => {
    const p = decodeSigningPayload(buildPayload({ address: ALICE, method: tx.balances.transferKeepAlive(BOB, 5n * GEODE) }));
    expect(p.call).toEqual({ kind: "balances.transferKeepAlive", dest: BOB, value: 5n * GEODE });
  });

  it("hashes payloads longer than 256 bytes before signing, and the signature verifies", () => {
    const t = tool("geode_social_send_message_public");
    const bytes = buildPayload({ address: ALICE, method: contractCall(t, { new_message: "x".repeat(400), photo_or_youtube_link: "", website_or_document_link: "" }) });
    expect(bytes.length).toBeGreaterThan(256);
    expect(signingMessage(bytes)).toHaveLength(32);
    const pair = new Keyring({ type: "sr25519" }).addFromUri("//McpTest");
    const sig = pair.sign(signingMessage(bytes));
    expect(signatureVerify(signingMessage(bytes), sig, pair.address).isValid).toBe(true);
  });
});

describe("verifyPayload pins the runtime version", () => {
  const send = tool("geode_social_send_message_public");
  const args = { new_message: "[MCP-TEST] hi", photo_or_youtube_link: "", website_or_document_link: "" };
  const OFF_PIN = [
    { specVersion: 0xffffffff, transactionVersion: 2 },
    { specVersion: 0xdeadbeef, transactionVersion: 2 },
    { specVersion: 20260116, transactionVersion: 2 },
    { specVersion: 20260114, transactionVersion: 2 },
    { specVersion: 0, transactionVersion: 2 },
    { specVersion: 20260115, transactionVersion: 1 },
    { specVersion: 20260115, transactionVersion: 3 },
    { specVersion: 20260115, transactionVersion: 0xffffffff },
  ];

  it("matches the runtime version recorded in the real Geode metadata", () => {
    const v = consts.system.version;
    expect(GEODE_MAINNET.specVersions).toContain(v.specVersion.toNumber());
    expect(v.transactionVersion.toNumber()).toBe(GEODE_MAINNET.transactionVersion);
    expect(GEODE_MAINNET.specVersions).toContain(SPEC.specVersion);
    expect(SPEC.transactionVersion).toBe(GEODE_MAINNET.transactionVersion);
  });

  it("accepts the pinned runtime and reports it", () => {
    const v = verifyPayload(buildPayload({ address: ALICE, method: contractCall(send, args) }), OPTS(send.name));
    expect(v.payload.specVersion).toBe(20260115);
    expect(v.payload.txVersion).toBe(2);
  });

  it.each(OFF_PIN)("refuses a contract call for runtime %o", (runtime) => {
    const p = buildPayload({ address: ALICE, method: contractCall(send, args), runtime });
    expect(decodeSigningPayload(p).specVersion).toBe(runtime.specVersion);
    expect(() => verifyPayload(p, OPTS(send.name))).toThrow(RuntimeVersionError);
    expect(() => verifyPayload(p, OPTS(send.name))).toThrow(/Geode runtime/);
  });

  it.each(OFF_PIN)("refuses a matching transfer for runtime %o", (runtime) => {
    const p = buildPayload({ address: ALICE, method: tx.balances.transferKeepAlive(BOB, 5n * GEODE), runtime });
    expect(() => verifyPayload(p, OPTS("geode_balances_transfer", { expectTransfer: { dest: BOB, amount: 5n * GEODE } }))).toThrow(RuntimeVersionError);
  });

  it("reports the runtime first, before trying to read a call the new runtime may have changed", () => {
    // Under the pins this call is refused as unknown; under another runtime, the version is the reason.
    const m = tx.balances.transfer(BOB, GEODE);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: m }), OPTS("geode_balances_transfer"))).toThrow(/not an allowed call/);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: m, runtime: OFF_PIN[2]! }), OPTS("geode_balances_transfer"))).toThrow(RuntimeVersionError);
  });

  it("checkRuntimeVersion (also used by the server at startup) accepts only the pins", () => {
    expect(() => checkRuntimeVersion(20260115, 2)).not.toThrow();
    for (const r of OFF_PIN) expect(() => checkRuntimeVersion(r.specVersion, r.transactionVersion)).toThrow(RuntimeVersionError);
  });

  it("is a PayloadError, so every existing refusal path still refuses", () => {
    expect(new RuntimeVersionError("x")).toBeInstanceOf(PayloadError);
  });
});

describe("verifyPayload accepts only allowed, matching calls", () => {
  const send = tool("geode_social_send_message_public");
  const args = { new_message: "[MCP-TEST] hi", photo_or_youtube_link: "", website_or_document_link: "" };
  const good = () => buildPayload({ address: ALICE, method: contractCall(send, args) });

  it("accepts a well-formed intent and decodes its arguments", () => {
    const v = verifyPayload(good(), OPTS(send.name));
    expect(v.tool?.name).toBe(send.name);
    expect(v.args).toEqual(args);
  });

  it("rejects a payload that claims a different tool", () => {
    expect(() => verifyPayload(good(), OPTS("geode_social_follow_account"))).toThrow(/claims/);
  });

  it("rejects other chains, immortal eras, long eras, tips and asset fees", () => {
    const m = contractCall(send, args);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: m, genesisHash: "0x" + "00".repeat(32) }), OPTS(send.name))).toThrow(/another chain/);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: m, immortal: true }), OPTS(send.name))).toThrow(/immortal/);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: m, period: 1024 }), OPTS(send.name))).toThrow(/validity window/);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: m, tip: 1 }), OPTS(send.name))).toThrow(/tip/);
    // Flip the asset-id Option from None to Some(1): it sits after call, 2-byte era, nonce (7) and tip (0).
    const plain = buildPayload({ address: ALICE, method: m });
    const at = m.toU8a().length + 2 + 1 + 1;
    expect(plain[at]).toBe(0);
    const withAsset = Uint8Array.from([...plain.subarray(0, at), 1, 1, 0, 0, 0, ...plain.subarray(at + 1)]);
    expect(decodeSigningPayload(withAsset).assetId).toBe(1);
    expect(() => verifyPayload(withAsset, OPTS(send.name))).toThrow(/non-native asset/);
  });

  it("rejects non-allowlisted pallets and calls (allow-death transfer, transfer_all, batch)", () => {
    // Geode's balances pallet names the allow-death transfer plain `transfer`.
    for (const m of [tx.balances.transfer(BOB, 1n), tx.balances.transferAll(BOB, false), tx.balances.forceTransfer(ALICE, BOB, 1n)]) {
      const p = buildPayload({ address: ALICE, method: m });
      expect(() => verifyPayload(p, OPTS("geode_balances_transfer", { expectTransfer: { dest: BOB, amount: 1n } }))).toThrow(/not an allowed call/);
    }
    const batch = buildPayload({ address: ALICE, method: tx.utility.batch([contractCall(send, args)]) });
    expect(() => verifyPayload(batch, OPTS(send.name))).toThrow(/not an allowed call/);
  });

  it("rejects calls to non-Geode contracts and skipped selectors", () => {
    const foreign = buildPayload({ address: ALICE, method: contractCall(send, args, { dest: BOB }) });
    expect(() => verifyPayload(foreign, OPTS(send.name))).toThrow(/not one of the Geode contracts/);
    for (const s of SKIPPED) {
      const p = buildPayload({ address: ALICE, method: tx.contracts.call(addr(s.contract), 0, { refTime: 1, proofSize: 1 }, GEODE, s.selector) });
      expect(() => verifyPayload(p, OPTS("anything")), s.message).toThrow(/not an allowed message/);
    }
  });

  it("rejects value on non-payable tools, missing or excessive deposit limits, and read-only messages", () => {
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: contractCall(send, args, { value: 1n }) }), OPTS(send.name))).toThrow(/not payable/);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: contractCall(send, args, { sdl: null }) }), OPTS(send.name))).toThrow(/no explicit storage deposit/);
    expect(() => verifyPayload(buildPayload({ address: ALICE, method: contractCall(send, args, { sdl: 51n * GEODE }) }), OPTS(send.name))).toThrow(/storage deposit limit/);
    const q = tool("geode_dns_get_owner");
    const qp = buildPayload({ address: ALICE, method: contractCall(q, { name: "x" }) });
    expect(() => verifyPayload(qp, OPTS(q.name))).toThrow(/never signed/);
  });

  it("rejects value above the per-transaction cap", () => {
    const pay = tool("geode_messaging_send_paid_message");
    const p = buildPayload({ address: ALICE, method: contractCall(pay, { to_account: BOB, new_message: "x", file_url: "" }, { value: 1001n * GEODE }) });
    expect(() => verifyPayload(p, OPTS(pay.name))).toThrow(/exceeds the per-transaction cap/);
  });

  it("requires transfers to match the agent's own expectation exactly", () => {
    const p = buildPayload({ address: ALICE, method: tx.balances.transferKeepAlive(BOB, 5n * GEODE) });
    expect(() => verifyPayload(p, OPTS("geode_balances_transfer"))).toThrow(/expect/);
    expect(() => verifyPayload(p, OPTS("geode_balances_transfer", { expectTransfer: { dest: ALICE, amount: 5n * GEODE } }))).toThrow(/does not match/);
    expect(() => verifyPayload(p, OPTS("geode_balances_transfer", { expectTransfer: { dest: BOB, amount: 5n * GEODE + 1n } }))).toThrow(/does not match/);
    expect(verifyPayload(p, OPTS("geode_balances_transfer", { expectTransfer: { dest: BOB, amount: 5n * GEODE } })).value).toBe(5n * GEODE);
    expect(() => verifyPayload(p, OPTS(send.name))).toThrow(/coin transfer/);
    const toContract = buildPayload({ address: ALICE, method: tx.balances.transferKeepAlive(addr("Market"), 1n) });
    expect(() => verifyPayload(toContract, OPTS("geode_balances_transfer", { expectTransfer: { dest: addr("Market"), amount: 1n } }))).toThrow(/contracts are not allowed/);
  });

  it("rejects truncated, padded or garbage payloads", () => {
    const b = good();
    expect(() => verifyPayload(b.subarray(0, b.length - 1), OPTS(send.name))).toThrow(PayloadError);
    expect(() => verifyPayload(Uint8Array.from([...b, 0]), OPTS(send.name))).toThrow(PayloadError);
    expect(() => verifyPayload(Uint8Array.of(0x13, 0x06, 0x05), OPTS(send.name))).toThrow(PayloadError);
  });
});
