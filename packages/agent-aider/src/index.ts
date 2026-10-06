/**
 * `@cognia/agent-aider` — the Aider integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data), `./history` (the chat-history
 * reader, pure), `./cli-client` (the `aider-cli` adapter over host ports).
 * The barrel re-exports the runtime; consumers that only need data or formats
 * import their own entry point so no runtime code loads.
 */
export * from "./cli-client"
export * from "./history"
export * from "./manifest"
