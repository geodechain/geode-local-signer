/**
 * Extracting and hashing the MCP section of the published Terms page (plan §4.7).
 *
 * The hash is what agents sign. It must be stable against presentation changes to a shared
 * WordPress page, and must change the moment the terms themselves change.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TermsPageError, extractTermsSection, hashTermsPage, hashTermsSection } from "../../packages/shared/src/termsPage.ts";

/** Captured from https://geodechain.com/tos/ on 2026-09-22, the day it was published. */
const PUBLISHED_SECTION = readFileSync(join(import.meta.dirname, "../fixtures/tos-mcp-section.txt"), "utf8");
const PUBLISHED_SHA256 = "e5be558e8c1ce09a740726f733c6d676ba8308652472da6c16a57234d84f0e6d";

const page = (section: string, before = "<h2>9. How To Contact Us</h2><p>Contact the Council.</p>", after = "<h2>Infringement Countermeasures</h2><p>Reporting.</p>") =>
  `<html><body><article>${before}${section}${after}</article></body></html>`;

const SECTION = `<h2>10. Automated Access and AI Agents (MCP Service)</h2>
<p><strong>10.1 What this section covers.</strong> The Geode Foundation Inc operates a Model Context Protocol service. ${"Padding sentence to clear the minimum length. ".repeat(12)}</p>`;

describe("published terms section", () => {
  it("hashes the section as published on 2026-09-22", () => {
    // Regression guard: if this changes, the terms changed and the config hash must be updated.
    expect(hashTermsSection(PUBLISHED_SECTION)).toBe(PUBLISHED_SHA256);
    expect(PUBLISHED_SECTION).toContain("10.1 What this section covers");
    expect(PUBLISHED_SECTION).toContain("10.14 No advice");
  });

  it("covers our section only", () => {
    // Nothing from section 9 above it, nothing from the appendix below it.
    expect(PUBLISHED_SECTION.startsWith("10. Automated Access and AI Agents")).toBe(true);
    expect(PUBLISHED_SECTION).not.toContain("How To Contact Us");
    expect(PUBLISHED_SECTION).not.toContain("Infringement Countermeasures");
    expect(PUBLISHED_SECTION).not.toContain("Governing Law");
  });

  it("names the Foundation and the official endpoint", () => {
    expect(PUBLISHED_SECTION).toContain("The Geode Foundation Inc");
    expect(PUBLISHED_SECTION).toContain("https://mcp.geodeapps.com/mcp");
  });
});

describe("extraction boundaries", () => {
  it("takes the text between our heading and the next section", () => {
    const text = extractTermsSection(page(SECTION));
    expect(text.startsWith("10. Automated Access and AI Agents")).toBe(true);
    expect(text).not.toContain("How To Contact Us");
    expect(text).not.toContain("Reporting.");
  });

  it("runs to the end of the page when the following section is absent", () => {
    const text = extractTermsSection(page(SECTION, "", ""));
    expect(text).toContain("Model Context Protocol service");
  });

  it("refuses a page without our section, and an implausibly short one", () => {
    expect(() => extractTermsSection(page("<p>nothing here</p>"))).toThrow(TermsPageError);
    expect(() => extractTermsSection(page("<h2>10. Automated Access and AI Agents</h2><p>short</p>"))).toThrow(/implausibly short/);
  });
});

describe("hash stability against presentation changes", () => {
  const baseline = hashTermsPage(page(SECTION)).sha256;

  it("ignores edits elsewhere on the shared page", () => {
    // A typo fix in the website's own terms must not invalidate every agent's signature.
    const edited = page(SECTION, "<h2>9. How To Contact Us</h2><p>Contact the Council today.</p>", "<h2>Infringement Countermeasures</h2><p>Revised reporting text.</p>");
    expect(hashTermsPage(edited).sha256).toBe(baseline);
  });

  it("ignores markup, whitespace and theme changes", () => {
    const restyled = page(SECTION.replace(/<h2>/g, '<h2 class="et_pb_heading" id="mcp">').replace(/<p>/g, "<p>\n   ").replace(/<strong>/g, "<b>").replace(/<\/strong>/g, "</b>"));
    expect(hashTermsPage(restyled).sha256).toBe(baseline);
  });

  it("ignores curly quotes, non-breaking spaces and entity encoding", () => {
    const typographic = page(SECTION.replace(/"/g, "&#8220;").replace(/ /g, "&nbsp;"));
    expect(hashTermsPage(typographic).sha256).toBe(baseline);
  });

  it("ignores stray Markdown bold left by a paste", () => {
    // Exactly what happened on the live page: **The Geode Foundation Inc** rendered literally.
    const pasted = page(SECTION.replace("The Geode Foundation Inc", "**The Geode Foundation Inc**"));
    expect(hashTermsPage(pasted).sha256).toBe(baseline);
  });

  it("ignores injected scripts, styles and comments", () => {
    const withJunk = page(`<script>var x=1;</script><style>.a{}</style><!-- note -->${SECTION}`);
    expect(hashTermsPage(withJunk).sha256).toBe(baseline);
  });
});

describe("hash sensitivity to the terms themselves", () => {
  const baseline = hashTermsPage(page(SECTION)).sha256;

  it("changes when a single word of the terms changes", () => {
    expect(hashTermsPage(page(SECTION.replace("operates a Model", "operated a Model"))).sha256).not.toBe(baseline);
  });

  it("changes when a clause is removed", () => {
    expect(hashTermsPage(page(SECTION.replace("10.1 What this section covers.", ""))).sha256).not.toBe(baseline);
  });

  it("changes when a number changes", () => {
    const withCap = SECTION.replace("Model Context Protocol service", "limit of 1,000 GEODE per transaction");
    const changed = SECTION.replace("Model Context Protocol service", "limit of 10,000 GEODE per transaction");
    expect(hashTermsPage(page(withCap)).sha256).not.toBe(hashTermsPage(page(changed)).sha256);
  });
});
