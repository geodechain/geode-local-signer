/**
 * Text hygiene for contract strings (plan §3.3 inputs, §3.7 outputs).
 *
 * Invisible and direction-changing characters are the usual carriers for prompt-injection and
 * spoofing, so inputs containing them are rejected and outputs have them stripped.
 *
 * The forbidden set is written as numeric code-point ranges on purpose: this source file must never
 * itself contain the invisible characters it guards against.
 */

/** Inclusive code-point ranges that are rejected on input and stripped on output. */
export const FORBIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], // C0 controls (tab 0x09, LF 0x0a, CR 0x0d are allowed)
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f], // DEL + C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, LRM/RLM
  [0x202a, 0x202e], // bidi embeddings/overrides
  [0x2060, 0x2069], // word joiner, invisible operators, bidi isolates
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
];

function isForbidden(cp: number): boolean {
  return FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function findForbiddenChar(s: string): string | undefined {
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isForbidden(cp)) return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return undefined;
}

export function stripHidden(s: string): string {
  let out = "";
  for (const ch of s) {
    if (!isForbidden(ch.codePointAt(0)!)) out += ch;
  }
  return out;
}

const utf8Encoder = new TextEncoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8Bytes(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

/** Decode bytes as UTF-8, or return undefined if they are not valid UTF-8. */
export function tryUtf8(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export function toHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}
