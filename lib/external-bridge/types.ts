/**
 * External Bridge — public types.
 *
 * The bridge exposes Cognia's wiki / RAG / runtime knowledge to external
 * coding agents (Claude Code, Cursor, Cline, Codex) over MCP. This module
 * holds the small set of shared types that the handlers, server skeleton,
 * and Settings UI all import — to avoid a cycle between `lib/external-bridge/`
 * and `types/wiki/`.
 *
 * The `BridgeScope` / `ExternalBridgeSettings` types live in `types/wiki/`
 * and are re-exported here for ergonomic imports.
 */

export type { BridgeScope, ExternalBridgeSettings } from "@/types/wiki"
export {
  ALL_BRIDGE_SCOPES,
  DEFAULT_ENABLED_SCOPES,
  DEFAULT_EXTERNAL_BRIDGE_SETTINGS,
} from "@/types/wiki"

import type { BridgeScope } from "@/types/wiki"

/**
 * Result of a permission gate check. When `allowed === false`, `reason` is
 * required and surfaces in the MCP error response and audit log.
 */
export type ScopeCheckResult = { allowed: true } | { allowed: false; reason: string }

/**
 * Map from MCP tool name → required scope. Handlers consult this via
 * `requiredScopeForTool` when invoking the permission gate. Unknown tools
 * are denied with reason "unknown tool" so a typo can't accidentally pass.
 */
export const TOOL_TO_SCOPE: Record<string, BridgeScope> = {
  wiki_search: "wiki:cognia",
  wiki_read: "wiki:cognia",
  rag_search: "rag:cognia",
  // runtime_query takes an entityType arg — handler resolves the scope per call.
}

/**
 * Map from runtime entity type (the `runtime_query` arg) → required scope.
 * The handler does the lookup per call instead of declaring a single scope.
 */
export const RUNTIME_ENTITY_TO_SCOPE: Record<string, BridgeScope> = {
  skill: "runtime:skills",
  character: "runtime:characters",
  twin: "runtime:twins",
  plugin: "runtime:plugins",
  "agent-team": "runtime:agent-teams",
}
