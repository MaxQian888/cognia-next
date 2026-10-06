/**
 * `@cognia/agent-pi` — the Pi integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data), `./history` (the pure session-file
 * reader) and `./session-tree` (its tree walk), `./rpc-client` (the `pi-rpc`
 * adapter over host ports), `./rpc-peer` (strict LF framing), `./rpc-events`
 * (Pi events to canonical events), `./permission` (the native-tool table the
 * bundled extension applies), `./auth` (provider and credential probes).
 * The barrel re-exports the runtime; consumers that only need data import
 * `./manifest` or `./history` so no runtime code loads.
 */
export * from "./auth"
export * from "./history"
export * from "./manifest"
export * from "./permission"
export * from "./rpc-client"
export * from "./rpc-events"
export * from "./rpc-peer"
export * from "./session-tree"
