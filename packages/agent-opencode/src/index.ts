/**
 * `@cognia/agent-opencode` — the OpenCode integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data), `./history` (the pure session
 * reader: normalized records and share exports to the neutral transcript),
 * `./v2-client` (the `opencode-v2`
 * adapter over the current service API), `./v2-events` (service events to
 * canonical events), `./v2-launcher` (session-owned loopback services),
 * `./discovery` (locating a local service), `./client` (the `opencode` server
 * adapter over `@opencode-ai/sdk`). The barrel re-exports the runtime;
 * consumers that only need data import `./manifest` or `./history`.
 */
export * from "./client"
export * from "./discovery"
export * from "./history"
export * from "./manifest"
export * from "./v2-client"
export * from "./v2-events"
export * from "./v2-launcher"
