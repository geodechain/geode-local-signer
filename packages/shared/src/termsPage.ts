/**
 * Extracting the MCP section from the published Terms page (plan §4.7).
 *
 * Agents sign a statement naming the Terms version and a SHA-256. That hash has to cover OUR
 * section only: geodechain.com/tos/ is a shared page, and an unrelated edit elsewhere on it must
 * not look like tampering or force every agent to re-sign.
 *
 * The original design wrapped the section in HTML comments. WordPress strips comments on save, so
 * they did not survive publication. This anchors on the section heading instead, which is visible
 * text and therefore survives any editor.
 */
import { createHash } from "node:crypto";

export class TermsPageError extends Error {}

/** Start of our section: the "10. Automated Access and AI Agents" heading, however it is marked up. */
const SECTION_START = /10\.\s*Automated\s+Access\s+and\s+AI\s+Agents/i;

/** The next top-level heading after ours. Whatever follows is not part of the section. */
const SECTION_END = /Infringement\s+Countermeasures/i;

/** Tags whose contents are never part of the readable section. */
const DROP_BLOCKS = /<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Reduce published HTML to the plain text of the MCP section.
 *
 * Normalization is deliberately aggressive: the hash must survive the theme changing a tag, an
 * editor re-wrapping a paragraph, or a plugin inserting a non-breaking space, while still changing
 * if a single word of the terms changes.
 */
export function extractTermsSection(pageHtml: string): string {
  // Order matters: decode and normalize FIRST, then look for the boundaries. A heading whose
  // spaces are encoded as &nbsp; is still our heading, and an editor is free to do that.
  const text = pageHtml
    .replace(DROP_BLOCKS, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block-level tags become spaces so words never run together; inline tags simply vanish.
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|section|article|tr|td)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "");

  const normalized = decodeEntities(text)
    // Curly quotes, dashes and exotic spaces are presentation, not meaning.
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    // Markdown emphasis left behind by a paste is presentation too.
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const start = normalized.search(SECTION_START);
  if (start === -1) throw new TermsPageError("the MCP section heading was not found on the page");

  const rest = normalized.slice(start);
  const endRel = rest.search(SECTION_END);
  const section = (endRel === -1 ? rest : rest.slice(0, endRel)).trim();

  if (section.length < 500) {
    throw new TermsPageError(`the extracted MCP section is implausibly short (${section.length} characters)`);
  }
  return section;
}

/** The handful of entities that appear in WordPress output; enough for prose, by design. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;|&#160;|&#xa0;/gi, " ")
    .replace(/&#8217;|&rsquo;|&#8216;|&lsquo;/gi, "'")
    .replace(/&#8220;|&ldquo;|&#8221;|&rdquo;/gi, '"')
    .replace(/&#8212;|&mdash;/gi, "-")
    .replace(/&#8211;|&ndash;/gi, "-")
    .replace(/&hellip;|&#8230;/gi, "...")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">")
    // &amp; last, so "&amp;lt;" does not turn into "<".
    .replace(/&amp;|&#38;/gi, "&");
}

export function hashTermsSection(sectionText: string): string {
  return createHash("sha256").update(sectionText, "utf8").digest("hex");
}

/** Convenience: page HTML in, pinned hash out. */
export function hashTermsPage(pageHtml: string): { sha256: string; text: string } {
  const text = extractTermsSection(pageHtml);
  return { sha256: hashTermsSection(text), text };
}
