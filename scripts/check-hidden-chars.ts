/**
 * Fail if any committed source/text file contains invisible or bidi characters (trojan-source guard).
 * Uses the same code-point ranges as the runtime text filter.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { FORBIDDEN_RANGES } from "../packages/shared/src/text.ts";

const ROOTS = ["packages", "scripts", "test", "manifest", "docs", "deploy"];
const EXTENSIONS = /\.(ts|js|json|ya?ml|md)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage"]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (EXTENSIONS.test(p)) yield p;
  }
}

let problems = 0;
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const ch of line) {
        const cp = ch.codePointAt(0)!;
        // Tabs and carriage returns are fine in source files.
        if (cp === 0x09 || cp === 0x0d) continue;
        if (FORBIDDEN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) {
          console.error(`${file}:${i + 1}: hidden/control character U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
          problems++;
          break;
        }
      }
    });
  }
}
if (problems > 0) {
  console.error(`${problems} line(s) contain hidden characters`);
  process.exit(1);
}
console.log("no hidden characters found");
