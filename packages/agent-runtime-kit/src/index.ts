/**
 * `@cognia/agent-runtime-kit` — shared building blocks for external-agent
 * adapters (ADR-0217): the base adapter, JSON-RPC peer, LF frame decoding,
 * content-block helpers, unsupported-extension errors, orphan-process
 * reclaim, permission-mode ranking, history-reader building blocks, the
 * outbound-gate prompt check and the plugin-adapter compatibility wrapper. Depends only on
 * `@cognia/agent-contracts`; never on a host.
 */
export * from "./base-adapter"
export * from "./content-blocks"
export * from "./history"
export * from "./json-rpc-peer"
export * from "./lf-frame-decoder"
export * from "./permission-modes"
export * from "./plugin-compat"
export * from "./prompt-gate"
export * from "./session-extension-errors"
export * from "./spawn-reclaim"
