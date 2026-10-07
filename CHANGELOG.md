# Changelog

## 0.1.1

Security fix. Please update.

- The signer now checks the runtime version (`specVersion` and `transactionVersion`) in every payload and refuses any runtime it has not been checked against. Before, these fields were decoded but not compared to anything. After a Geode runtime upgrade that changed call layouts, a malicious or compromised server could have used an older signer to sign bytes that the signer read as one allowed action but the chain would run as another. No such upgrade has happened; Geode mainnet still runs runtime 20260115 (transaction version 2).
- When a payload names another runtime, the refusal tells you to update your signer. The signer decides this from the payload alone; the server cannot switch the message off.
- `sign_intent` and `sign_and_submit` now report the `spec_version` and `transaction_version` they verified.

## 0.1.0

First public release.

- Independently decodes and verifies every transaction a Geode MCP server prepares, and signs only allowed Geode calls that match what they claim to be.
- Tools: `create_account`, `list_accounts`, `use_account`, `accept_terms`, `sign_intent`, `sign_and_submit`.
- Its own per-transaction and rolling 24-hour GEODE limits (`--per-tx-geode`, `--per-day-geode`).
- Tells you to update when a refusal may be because the server has newer tools.
- Published as one self-contained file with no runtime dependencies.
