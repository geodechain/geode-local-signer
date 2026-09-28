/**
 * Builds the local signer into ONE JavaScript file with every dependency inside it.
 *
 *   node scripts/build-signer.ts            → dist/geode-local-signer.mjs
 *
 * Why one file: the published package then has no dependencies, so installing it downloads nothing
 * but this file. Every line that runs on a user's machine is a line we built and tested; a
 * dependency compromised on npm after our release cannot reach existing users. It is also plain
 * JavaScript, because Node will not run TypeScript from inside node_modules.
 *
 * Not minified, so the published file can be read and compared with the source. Third-party
 * license notices are kept at the end of the file.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { build } from "esbuild";

import { REGISTRY_VERSION } from "../packages/shared/src/index.ts";
import { SIGNER_VERSION } from "../packages/local-signer/src/version.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const OUT = join(ROOT, "dist", "geode-local-signer.mjs");

mkdirSync(join(ROOT, "dist"), { recursive: true });
await build({
  entryPoints: [join(ROOT, "packages/local-signer/src/index.ts")],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "eof",
  logLevel: "warning",
  banner: {
    // Some bundled CommonJS code calls require(); give it one in this ES module.
    js: "#!/usr/bin/env node\nimport { createRequire as __geodeCreateRequire } from 'node:module';\nconst require = __geodeCreateRequire(import.meta.url);",
  },
});
chmodSync(OUT, 0o755);

// The built file must run and report the version it was built from.
const version = execFileSync(process.execPath, [OUT, "--version"], { encoding: "utf8" }).trim();
const expected = `geode-local-signer ${SIGNER_VERSION} (tool list ${REGISTRY_VERSION})`;
if (version !== expected) throw new Error(`built signer reports "${version}", expected "${expected}"`);

const bytes = readFileSync(OUT);
console.log(`${OUT}\n${(bytes.length / 1024 / 1024).toFixed(2)} MB  sha256 ${createHash("sha256").update(bytes).digest("hex")}\n${version}`);
