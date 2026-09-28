# Changelog

## 0.1.0

First public release.

- Independently decodes and verifies every transaction a Geode MCP server prepares, and signs only allowed Geode calls that match what they claim to be.
- Tools: `create_account`, `list_accounts`, `use_account`, `accept_terms`, `sign_intent`, `sign_and_submit`.
- Its own per-transaction and rolling 24-hour GEODE limits (`--per-tx-geode`, `--per-day-geode`).
- Tells you to update when a refusal may be because the server has newer tools.
- Published as one self-contained file with no runtime dependencies.
