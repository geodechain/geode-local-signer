# Geode local signer

Signs Geode blockchain transactions **on your own machine**, for AI agents that use the [Geode MCP server](https://mcp.geodeapps.com/mcp).

The Geode MCP server lets an agent read from and write to Geode's apps (marketplace, social, messaging, surveys and more). The server never holds your keys. When your agent wants to write, the server *prepares* an unsigned transaction, and this signer:

1. **decodes it independently**, without trusting anything the server says about it: which chain, which app contract, which action, which arguments, how much GEODE;
2. **refuses** anything that isn't an allowed Geode action matching what it claims to be;
3. only then **signs** it, with a key that never leaves your machine.

It runs next to your agent as a local MCP server (stdio). No key, password or recovery phrase is ever returned by any of its tools, so none can end up in a model's context.

Using the Geode MCP server is governed by Section 10 of the Geode Terms of Use: <https://geodechain.com/tos/>.

## Install

You need **Node.js 22 or newer**.

Add the signer to your agent's MCP configuration, next to the Geode server. Use full paths, and pin the version:

```json
{
  "mcpServers": {
    "geode": { "url": "https://mcp.geodeapps.com/mcp" },
    "geode-signer": {
      "command": "npx",
      "args": [
        "-y", "@geodechain/local-signer@0.1.0",
        "--dir", "/Users/you/geode-keys",
        "--server", "https://mcp.geodeapps.com/mcp",
        "--per-tx-geode", "50",
        "--per-day-geode", "200"
      ]
    }
  }
}
```

Create the keys folder first, readable only by you:

```bash
mkdir -p ~/geode-keys && chmod 700 ~/geode-keys
```

### From source

```bash
git clone https://github.com/geodechain/geode-local-signer.git
cd geode-local-signer
git checkout v0.1.0
npm ci
npm test
npm run build            # → dist/geode-local-signer.mjs
```

Then use `"command": "node", "args": ["/full/path/to/dist/geode-local-signer.mjs", "--dir", …]`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `--dir <folder>` | *(required)* | Folder holding your accounts. Keep it at `700` |
| `--server <url>` | — | The Geode MCP server, for `accept_terms` and `sign_and_submit`. Use `https://mcp.geodeapps.com/mcp` |
| `--per-tx-geode <n>` | `1000` | Refuse to sign any single transaction sending more than this much GEODE |
| `--per-day-geode <n>` | `100000` | Refuse once this much GEODE has been signed away in a rolling 24 hours |
| `--max-storage-deposit-geode <n>` | `50` | Refuse transactions that could lock more than this much GEODE as a storage deposit |
| `--version` | | Print the version and the tool-list version, then exit |

**Set `--per-tx-geode` and `--per-day-geode` to what your agent actually needs.** They are enforced here, on your machine, whatever any server says.

## Tools

| Tool | What it does |
|---|---|
| `create_account` | Creates a new account in `--dir`. Returns only its address. The recovery phrase goes to a file named `<name>-RECOVERY-PHRASE-move-offline-then-delete.txt`: copy it somewhere safe offline, then delete the file |
| `list_accounts` | Lists your accounts (name, address, whether each is ready to sign) |
| `use_account` | Chooses the default account for `accept_terms` |
| `accept_terms` | Signs your acceptance of the Geode MCP Terms of Use (once per account, per Terms version) and records it with the server |
| `sign_intent` | Verifies and signs a transaction prepared by the server; returns the signature |
| `sign_and_submit` | Verifies, signs and submits it; returns the on-chain result |

**Existing accounts:** put the polkadot.js JSON keystore (`<address>.json`) in `--dir`, with a file `<name>-password.txt` containing only its password. Keep the files at `600`.

## What it refuses to sign

- a transaction for another chain, or one that never expires;
- anything other than a call to one of Geode's eight app contracts or a keep-alive GEODE transfer (so it can never empty your account);
- an action that isn't in its tool list, or a payload that doesn't match the action it claims;
- GEODE attached to an action that doesn't take payment;
- more GEODE than `--per-tx-geode` or `--per-day-geode` allow, or a storage deposit above `--max-storage-deposit-geode`;
- a transfer whose recipient and amount don't match what your agent stated separately (`expect`).

When a refusal might mean the server has tools newer than this signer knows, the message tells you how to update.

## Keeping it genuine

- **Pin an exact version** in your configuration, as above, and update deliberately.
- Releases are built and published only by this repository's GitHub Actions workflow, with **npm provenance** linking each version to the commit that built it. Check with `npm audit signatures`.
- The published file is not minified, so you can read it and compare it with the source.
- It has **no runtime dependencies**: installing it downloads this one file and nothing else.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately to **support@geodechain.com**.

## License

Apache License 2.0. Copyright 2026 The Geode Foundation Inc. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
