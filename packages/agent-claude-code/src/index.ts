/**
 * `@cognia/agent-claude-code` — the Claude Code integration (ADR-0217).
 *
 * Entry points: `./manifest` (the ecosystem and runtime catalog rows) and
 * `./history` (the pure transcript reader). Both are data-only; Claude Code's
 * runtime client is the ACP client in `@cognia/agent-acp`.
 */
export * from "./history"
export * from "./manifest"
