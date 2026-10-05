/**
 * `@cognia/agent-codex` — the Codex integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data), `./app-server-client` (the
 * `codex-app-server` adapter), `./config-requirements`, `./mcp-config`.
 * The barrel re-exports the runtime; consumers that only need data or formats
 * import their own entry point so no runtime code loads.
 */
export * from "./app-server-client"
export * from "./config-requirements"
export * from "./manifest"
export * from "./mcp-config"
