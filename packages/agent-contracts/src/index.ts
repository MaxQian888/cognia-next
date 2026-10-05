/**
 * `@cognia/agent-contracts` — the lowest layer of Cognia's agent packages
 * (ADR-0217): identity, external-agent wire/session/config contracts, the
 * adapter core and optional capabilities, execution semantics and host ports.
 *
 * Depends on nothing at runtime. Subpath entries (`./external-agent`,
 * `./adapter`, …) are the stable import paths; this barrel re-exports them.
 */
export * from "./adapter"
export * from "./adapter-extension"
export * from "./canonical-event"
export * from "./canonical-session"
export * from "./capability-ids"
export * from "./ecosystem"
export * from "./external-agent"
export * from "./external-agent-capability"
export * from "./external-agent-lifecycle"
export * from "./extension-ui"
export * from "./host"
export * from "./model-binding"
export * from "./ref-safety"
export * from "./semantics"
export * from "./session-operations"
