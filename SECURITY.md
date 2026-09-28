# Security policy

The Geode local signer holds the keys to its users' Geode accounts, so we take reports about it seriously.

## Reporting a vulnerability

Email **support@geodechain.com** with "SECURITY" in the subject line. Please include:

- what you found, and which version (`geode-local-signer --version`);
- how to reproduce it;
- what an attacker could do with it.

Please **do not** open a public GitHub issue for a vulnerability, and do not test against accounts that are not yours. We will acknowledge your report, keep you informed, and credit you in the release notes if you wish.

## How this repository is maintained

This repository is generated from Geode's private MCP monorepo, which is the single source of truth. Changes, including dependency updates, are made there, tested, and exported here; pull requests opened directly against this repository cannot be merged as they are, but are welcome as reports.

## What is in scope

- The signer signing anything other than what it claims to have verified.
- Any way to make the signer reveal a key, password or recovery phrase.
- Any way for a malicious or compromised Geode MCP server to obtain a signature for a transaction the user did not request.
- Weaknesses in how accounts are created or stored on disk.

## Verifying a release

Every npm release is built by this repository's GitHub Actions workflow, approved in GitHub, staged on npm with provenance, and made public only when a maintainer approves it on npm with two-factor authentication. You can check that the package you installed was built from this repository:

```bash
npm audit signatures
```

Each GitHub Release also lists the SHA-256 of `geode-local-signer.mjs`.
