/**
 * `@cognia/agent-acp` — the Agent Client Protocol integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data), `./client` (the `acp` adapter over
 * host ports), `./devin-adapter` (one ACP process per Devin conversation),
 * `./registry` (ACP Registry v1), and the protocol helpers `./wire-codec`,
 * `./feature-profile`, `./permission-input` and `./devin-model-axis`. Vendor
 * deviations are profiles: `./vendor-profile` (the contract and resolver),
 * `./vendor-profiles` (the shipped set) and `./vendors/<id>`.
 */
export * from "./client"
export * from "./devin-adapter"
export * from "./devin-model-axis"
export * from "./feature-profile"
export * from "./manifest"
export * from "./permission-input"
export * from "./registry"
export * from "./vendor-profile"
export * from "./vendor-profiles"
export * from "./wire-codec"
