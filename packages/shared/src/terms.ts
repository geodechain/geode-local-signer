/**
 * The Terms of Use acceptance statement (plan §3.8). Server and local signer build it identically;
 * it is signed with signRaw semantics (wrapped in <Bytes>…</Bytes>) so it can never be a transaction.
 */
import { stringToU8a, u8aWrapBytes } from "@polkadot/util";

export interface TermsRef {
  domain: string;
  url: string;
  version: string;
  sha256: string;
}

/** Acceptances older or newer than this (vs. the server clock) are rejected. */
export const TERMS_TIMESTAMP_SKEW_MS = 5 * 60_000;

export function termsStatement(t: TermsRef, signer: string, timestamp: string): string {
  return [
    "I accept the Geode MCP Terms of Use",
    `domain=${t.domain}`,
    `url=${t.url}`,
    `version=${t.version}`,
    `sha256=${t.sha256}`,
    `signer=${signer}`,
    `timestamp=${timestamp}`,
  ].join(" | ");
}

/** The exact bytes that are signed for a statement (signRaw wrapping). */
export function termsMessage(statement: string): Uint8Array {
  return u8aWrapBytes(stringToU8a(statement));
}
