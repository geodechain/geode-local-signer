/**
 * Pinned facts about Geode mainnet's transaction format (read from runtime spec 20260115 metadata,
 * 2026-09-19). The local signer decodes payloads with these pins and no chain connection; the server
 * verifies at startup that the live runtime still matches them and refuses to start otherwise.
 */
export const GEODE_MAINNET = {
  genesisHash: "0xfa294dfb0e74160a9800d56231927655ba43d52add29c1982ab59574cc51cc90",
  ss58Prefix: 42,
  decimals: 12,
  extrinsicVersion: 4,
  /** Signed extensions in order. Extra (in the payload after the call): era, nonce, tip + assetId. */
  signedExtensions: [
    "CheckNonZeroSender",
    "CheckSpecVersion",
    "CheckTxVersion",
    "CheckGenesis",
    "CheckMortality",
    "CheckNonce",
    "CheckWeight",
    "ChargeAssetTxPayment",
  ],
  calls: {
    /** contracts.call(dest: MultiAddress, value: Compact<u128>, gas_limit: Weight, storage_deposit_limit: Option<Compact<u128>>, data: Bytes) */
    contractsCall: { index: "0x1306", args: ["MultiAddress", "Compact<u128>", "SpWeightsWeightV2Weight", "Option<Compact<u128>>", "Bytes"] },
    /** balances.transfer_keep_alive(dest: MultiAddress, value: Compact<u128>) */
    balancesTransferKeepAlive: { index: "0x0603", args: ["MultiAddress", "Compact<u128>"] },
  },
  /** Mortal era period used for intents (blocks). */
  eraPeriod: 64,
} as const;

/** Longest validity window the signer accepts (blocks). */
export const MAX_ERA_PERIOD = 256;
