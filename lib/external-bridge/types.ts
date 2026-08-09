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
  WORKFLOW_MCP_LIFECYCLE_TOOL_NAMES,
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
  computer_use: "mcp:computer-use",
  // runtime_query takes an entityType arg — handler resolves the scope per call.
  // v49 — Inbox connectors. Read tools group under `:read`; the send tool
  // is split off so an operator can grant observability without enabling
  // automated replies.
  connectors_list_adapters: "inbox:connectors:read",
  connectors_list_conversations: "inbox:connectors:read",
  connectors_get_audit: "inbox:connectors:read",
  connectors_export_audit: "inbox:connectors:read",
  connectors_list_drafts: "inbox:connectors:read",
  connectors_send_message: "inbox:connectors:send",
  // Orchestration tools — let an external agent drive Cognia's own agent
  // runtime / teams / plugin tools (Thread D). Default OFF; outward text is
  // PII-gated and plugin tools keep their own consent gate.
  agent_dispatch: "agent:dispatch",
  spawn_task: "agent:dispatch",
  team_run: "agent:team",
  team_list: "agent:team",
  plugin_tool_invoke: "plugin:tools",
  schedule_task: "agent:dispatch",
  list_scheduled_tasks: "agent:dispatch",
  cancel_scheduled_task: "agent:dispatch",
  // Inbound write tools (ADR-0008 Phase 4). All three share one scope; each
  // submission lands in the `inboundDrafts` review queue, never live state.
  record_lesson: "inbound:write",
  save_skill_draft: "inbound:write",
  ingest_note: "inbound:write",
  // Long-term memory tools (ADR-0069). Read/write split like the inbox pair;
  // writes carry `external` provenance, are PII-block-gated, never procedural.
  memory_search: "memory:read",
  memory_list: "memory:read",
  memory_store: "memory:write",
  memory_update: "memory:write",
  memory_forget: "memory:write",
  workflow_list: "workflow:run",
  workflow_status: "workflow:run",
  workflow_events: "workflow:run",
  workflow_cancel: "workflow:run",
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
