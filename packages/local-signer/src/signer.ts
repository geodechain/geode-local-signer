/**
 * geode-local-signer core. Runs on the agent's machine; holds the only copy of the keys.
 *
 * - Accounts are discovered in one folder: `<address>.json` (polkadot.js keystore) + `<name>-password.txt`.
 * - Every intent is decoded and checked INDEPENDENTLY of the server before signing (plan §2.1 step 3).
 * - Keys are unlocked only for the moment of signing, then locked again.
 * - Passwords, seed phrases and private keys are never returned, logged, or sent anywhere.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  GEODE_MAINNET,
  PayloadError,
  REGISTRY_VERSION,
  RuntimeVersionError,
  formatBalance,
  parseBalance,
  signingMessage,
  termsMessage,
  termsStatement,
  toHex,
  verifyPayload,
  type ChainFormat,
  type TermsRef,
} from "@geode-mcp/shared";
import { Keyring } from "@polkadot/keyring";
import type { KeyringPair, KeyringPair$Json } from "@polkadot/keyring/types";
import { hexToU8a, isHex } from "@polkadot/util";
import { cryptoWaitReady, encodeAddress, mnemonicGenerate } from "@polkadot/util-crypto";

export class SignerError extends Error {}

/** Where users get a current signer; shown when a refusal may just mean this signer is out of date. */
export const UPDATE_COMMAND = "npx @geodechain/local-signer@latest";

/**
 * When the server's tool registry differs from this signer's, a refusal may simply mean the server
 * has tools this signer does not know yet. The server's claim is used ONLY to word the message: the
 * refusal stands either way, and nothing is ever signed on the server's say-so.
 */
function outdatedHint(serverRegistry: unknown): string {
  if (typeof serverRegistry !== "string" || serverRegistry === REGISTRY_VERSION) return "";
  return ` (this signer's tool list, version ${REGISTRY_VERSION}, differs from the server's, ${serverRegistry.slice(0, 32)}: if the server has added or changed tools, update your signer with \`${UPDATE_COMMAND}\`)`;
}

/**
 * Wording for a refusal caused by the payload's runtime version. It rests only on what this signer
 * decoded itself, never on anything the server says, so a server cannot suppress it.
 */
function runtimeHint(): string {
  return ` (if Geode has upgraded its runtime, update your signer with \`${UPDATE_COMMAND}\`; nothing was signed)`;
}

export const FORMAT: ChainFormat = { outputSs58Prefix: GEODE_MAINNET.ss58Prefix, acceptedSs58Prefixes: [GEODE_MAINNET.ss58Prefix], decimals: GEODE_MAINNET.decimals };

export interface SignerOptions {
  /** Folder holding keystores and password files (and where new accounts are created). */
  dir: string;
  perTxGeode?: string;
  perDayGeode?: string;
  maxStorageDepositGeode?: string;
  createAccountDailyLimit?: number;
  now?: () => number;
}

export interface AccountEntry {
  name: string;
  address: string;
  keystorePath: string;
  passwordPath: string | null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,31}$/;

function readJson(path: string): KeyringPair$Json | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is inside the operator-chosen folder
    const j = JSON.parse(readFileSync(path, "utf8")) as KeyringPair$Json;
    return typeof j.address === "string" && typeof j.encoded === "string" ? j : null;
  } catch {
    return null;
  }
}

export class LocalSigner {
  private readonly dir: string;
  private readonly perTx: bigint;
  private readonly perDay: bigint;
  private readonly maxStorageDeposit: bigint;
  private readonly createLimit: number;
  private readonly now: () => number;
  private active: string | null = null;

  constructor(o: SignerOptions) {
    this.dir = o.dir;
    this.perTx = parseBalance("perTxGeode", o.perTxGeode ?? "1000", FORMAT.decimals);
    this.perDay = parseBalance("perDayGeode", o.perDayGeode ?? "100000", FORMAT.decimals);
    this.maxStorageDeposit = parseBalance("maxStorageDepositGeode", o.maxStorageDepositGeode ?? "50", FORMAT.decimals);
    this.createLimit = o.createAccountDailyLimit ?? 20;
    this.now = o.now ?? Date.now;
  }

  static async create(o: SignerOptions): Promise<LocalSigner> {
    await cryptoWaitReady();
    return new LocalSigner(o);
  }

  /** Accounts found in the folder: `<something>.json` keystores with a matching `<name>-password.txt`. */
  accounts(): AccountEntry[] {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-chosen folder
    const files = readdirSync(this.dir);
    const out: AccountEntry[] = [];
    for (const f of files.filter((x) => x.endsWith(".json")).sort()) {
      const j = readJson(join(this.dir, f));
      if (j === null) continue;
      const address = encodeAddress(j.address, GEODE_MAINNET.ss58Prefix);
      const name = typeof j.meta?.name === "string" && j.meta.name ? j.meta.name : address;
      const candidates = [`${name}-password.txt`, `${address}-password.txt`];
      const pw = candidates.find((c) => files.includes(c));
      out.push({ name, address, keystorePath: join(this.dir, f), passwordPath: pw ? join(this.dir, pw) : null });
    }
    return out;
  }

  listAccounts(): { name: string; address: string; ready: boolean; active: boolean }[] {
    const active = this.activeAddress();
    return this.accounts().map((a) => ({ name: a.name, address: a.address, ready: a.passwordPath !== null, active: a.address === active }));
  }

  private find(nameOrAddress: string): AccountEntry {
    const a = this.accounts().find((x) => x.name === nameOrAddress || x.address === nameOrAddress);
    if (a === undefined) throw new SignerError(`no local account named or addressed "${nameOrAddress}"`);
    return a;
  }

  useAccount(nameOrAddress: string): { name: string; address: string } {
    const a = this.find(nameOrAddress);
    this.active = a.address;
    return { name: a.name, address: a.address };
  }

  activeAddress(): string | null {
    return this.active ?? this.accounts()[0]?.address ?? null;
  }

  /** Unlock, run `fn`, and always lock again. Tries the password exactly, then whitespace-trimmed. */
  private withUnlocked<T>(a: AccountEntry, fn: (pair: KeyringPair) => T): T {
    if (a.passwordPath === null) throw new SignerError(`no password file for ${a.name} (expected "${a.name}-password.txt" in the accounts folder)`);
    const json = readJson(a.keystorePath);
    if (json === null) throw new SignerError(`keystore for ${a.name} is unreadable`);
    const pair = new Keyring({ type: "sr25519", ss58Format: GEODE_MAINNET.ss58Prefix }).addFromJson(json);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- password file inside the operator-chosen folder
    const raw = readFileSync(a.passwordPath, "utf8");
    let unlocked = false;
    for (const pw of [raw, raw.trim()]) {
      try {
        pair.decodePkcs8(pw);
        unlocked = !pair.isLocked;
      } catch {
        unlocked = false;
      }
      if (unlocked) break;
    }
    if (!unlocked) throw new SignerError(`the password file for ${a.name} does not unlock its keystore`);
    try {
      return fn(pair);
    } finally {
      pair.lock();
    }
  }

  /**
   * Independently verify an intent's signing payload and, only if it passes, sign it.
   * `expect` is mandatory for coin transfers: the agent restates recipient and amount itself.
   */
  signIntent(intent: { intent_id: string; tool: string; signer: string; signing_payload: string; registry_version?: unknown }, expect?: { dest: string; amount: string }): Record<string, unknown> {
    if (typeof intent?.signing_payload !== "string" || !isHex(intent.signing_payload)) throw new SignerError("intent.signing_payload must be hex");
    let signerAddress: string;
    try {
      signerAddress = encodeAddress(intent.signer, GEODE_MAINNET.ss58Prefix);
    } catch {
      throw new SignerError("intent.signer is not a valid address");
    }
    const account = this.find(signerAddress);
    const payload = hexToU8a(intent.signing_payload);
    let verified;
    try {
      verified = verifyPayload(payload, {
        toolName: intent.tool,
        fmt: FORMAT,
        maxValue: this.perTx,
        maxStorageDeposit: this.maxStorageDeposit,
        ...(expect ? { expectTransfer: { dest: expect.dest, amount: parseBalance("expect.amount", expect.amount, FORMAT.decimals) } } : {}),
      });
    } catch (e) {
      if (e instanceof RuntimeVersionError) throw new SignerError(`REFUSED to sign: ${e.message}${runtimeHint()}`);
      if (e instanceof PayloadError) throw new SignerError(`REFUSED to sign: ${e.message}${outdatedHint(intent.registry_version)}`);
      throw e;
    }
    // The signer's own rolling 24h cap (independent of the server's). Counted when signed, since the
    // signer cannot know whether the agent will submit; this errs on the safe side.
    if (verified.value > 0n) {
      const spent = this.signedLast24h(account.address);
      if (spent + verified.value > this.perDay) {
        throw new SignerError(`REFUSED to sign: this would exceed this signer's ${formatBalance(this.perDay, FORMAT.decimals)} GEODE rolling 24-hour cap (already signed ${formatBalance(spent, FORMAT.decimals)})`);
      }
    }
    const signature = this.withUnlocked(account, (pair) => toHex(pair.sign(signingMessage(payload), { withType: true })));
    if (verified.value > 0n) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the operator-chosen folder
      appendFileSync(join(this.dir, ".spend-ledger.jsonl"), JSON.stringify({ at: new Date(this.now()).toISOString(), address: account.address, value: verified.value.toString(), intent_id: intent.intent_id }) + "\n", { mode: 0o600 });
    }
    const call = verified.payload.call;
    return {
      ok: true,
      intent_id: intent.intent_id,
      signer: account.address,
      signature,
      verified: {
        tool: verified.tool?.name ?? intent.tool,
        contract: verified.tool?.contract ?? null,
        destination: call.dest,
        args: verified.args,
        value_geode: formatBalance(verified.value, FORMAT.decimals),
        ...(call.kind === "contracts.call" && call.storageDepositLimit !== null ? { storage_deposit_limit_geode: formatBalance(call.storageDepositLimit, FORMAT.decimals) } : {}),
        nonce: verified.payload.nonce.toString(),
        valid_for_blocks: verified.payload.era.mortal ? verified.payload.era.period : null,
        spec_version: verified.payload.specVersion,
        transaction_version: verified.payload.txVersion,
      },
    };
  }

  /** GEODE value this signer has signed away for `address` in the last 24 hours. */
  signedLast24h(address: string): bigint {
    const path = join(this.dir, ".spend-ledger.jsonl");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the operator-chosen folder
    if (!existsSync(path)) return 0n;
    const since = this.now() - 24 * 3600_000;
    let total = 0n;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the operator-chosen folder
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line) as { at: string; address: string; value: string };
      if (e.address === address && Date.parse(e.at) >= since) total += BigInt(e.value);
    }
    return total;
  }

  /** Sign the Terms of Use acceptance statement (signRaw-wrapped; can never be a transaction). */
  acceptTerms(terms: TermsRef, signerNameOrAddress?: string): { signer: string; timestamp: string; signature: string; statement: string } {
    const who = signerNameOrAddress ?? this.activeAddress();
    if (who === null) throw new SignerError("no local accounts");
    const account = this.find(who);
    const timestamp = new Date(this.now()).toISOString();
    const statement = termsStatement(terms, account.address, timestamp);
    const signature = this.withUnlocked(account, (pair) => toHex(pair.sign(termsMessage(statement))));
    return { signer: account.address, timestamp, signature, statement };
  }

  /**
   * Create a new account on this machine. Returns only public information and file paths; the
   * recovery phrase is written once to a file for the owner to move offline.
   */
  createAccount(name: string): Record<string, unknown> {
    if (!NAME_RE.test(name)) throw new SignerError("name must be 1–32 characters: letters, digits, space, _ or -, starting with a letter or digit");
    if (this.accounts().some((a) => a.name === name)) throw new SignerError(`an account named "${name}" already exists`);
    const ledger = join(this.dir, ".accounts-created.jsonl");
    const dayAgo = this.now() - 24 * 3600_000;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the operator-chosen folder
    const recent = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter((l) => l && Date.parse((JSON.parse(l) as { at: string }).at) > dayAgo).length : 0;
    if (recent >= this.createLimit) throw new SignerError(`account creation limit reached (${this.createLimit} per 24 h)`);

    // JavaScript strings cannot be wiped from memory; the phrase is kept in one local variable, written
    // once to the backup file, and never returned, logged or sent anywhere.
    const mnemonic = mnemonicGenerate(24);
    const password = randomBytes(24).toString("base64url");
    const pair = new Keyring({ type: "sr25519", ss58Format: GEODE_MAINNET.ss58Prefix }).addFromUri(mnemonic, { name }, "sr25519");
    const address = pair.address;
    const files = {
      keystore: join(this.dir, `${address}.json`),
      password: join(this.dir, `${name}-password.txt`),
      recovery_phrase_backup: join(this.dir, `${name}-RECOVERY-PHRASE-move-offline-then-delete.txt`),
    };
    const write = (p: string, content: string): void => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the operator-chosen folder
      writeFileSync(p, content, { mode: 0o600, flag: "wx" });
    };
    write(files.keystore, JSON.stringify(pair.toJson(password)));
    write(files.password, password);
    write(
      files.recovery_phrase_backup,
      `Recovery phrase for Geode account "${name}" (${address}).\nAnyone with these words controls the account. Move them somewhere safe and offline, then delete this file.\n\n${mnemonic}\n`,
    );
    pair.lock();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the operator-chosen folder
    appendFileSync(ledger, JSON.stringify({ at: new Date(this.now()).toISOString(), address, name }) + "\n", { mode: 0o600 });
    return {
      ok: true,
      name,
      address,
      funded: false,
      files,
      next_step: `The account exists on-chain only after it receives at least the existential deposit (1 GEODE). Fund it, e.g. with geode_balances_transfer from another of your accounts.`,
      notice: "The recovery phrase was written to the backup file above and is not shown here. Move it offline, then delete the file.",
    };
  }
}
