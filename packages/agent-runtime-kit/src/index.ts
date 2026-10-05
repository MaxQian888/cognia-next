/**
 * `@cognia/agent-runtime-kit` — shared building blocks for external-agent
 * adapters (ADR-0217): the base adapter, JSON-RPC peer, LF frame decoding,
 * content-block helpers, unsupported-extension errors, orphan-process
 * reclaim and permission-mode ranking. Depends only on
 * `@cognia/agent-contracts`; never on a host.
 */
export * from "./base-adapter"
export * from "./content-blocks"
export * from "./json-rpc-peer"
export * from "./lf-frame-decoder"
export * from "./permission-modes"
export * from "./session-extension-errors"
export * from "./spawn-reclaim"
