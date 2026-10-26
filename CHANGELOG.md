# Changelog

## 0.1.2

Please update: signers older than 0.1.2 cannot sign for Geode mainnet any more.

- Geode mainnet upgraded to runtime 20261018 (transaction version 2). The signer now accepts it. Its metadata was checked against every pinned call and signed extension: apart from the runtime version itself, it is identical to runtime 20260115, so nothing the signer checks has changed.
- Runtime 20260115 is still accepted.
- Surveys: the signer now knows the redeployed Surveys contract (5GAFN2mYJ4BbrYGUvqu3ZKxE9Va6XoAPYY19PmAwrxiU2c2W) and the new read-only `geode_surveys_get_survey_by_id` tool. Older signers refuse survey transactions to the new contract.
- Dependency updates for recently published advisories: `@modelcontextprotocol/sdk` 1.32.0 and `zod` 4.6.6, both bundled into the signer.

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
