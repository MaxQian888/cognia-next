/**
 * `@cognia/agent-dsh` — the DeepSeek Harness integration (ADR-0217).
 *
 * Entry points: `./manifest` (pure data), `./sdk-client` (the `dsh-sdk`
 * adapter), `./transport` (the process transport over an `AgentProcessHost`),
 * `./event-codec`, `./channel`, `./install`, `./managed-launch`.
 */
export * from "./channel"
export * from "./event-codec"
export * from "./install"
export * from "./managed-launch"
export * from "./manifest"
export * from "./sdk-client"
export * from "./transport"
