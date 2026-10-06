/**
 * `@cognia/agent-a2a` — the A2A integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data) and `./client` (the `a2a` adapter
 * over the host's fetch and outbound gate).
 */
export * from "./client"
export * from "./manifest"
