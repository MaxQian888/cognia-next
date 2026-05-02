/**
 * lib/db barrel — re-exports common DB modules and a few migrated-code
 * stub types for compatibility with upstream-style imports.
 */

export * from "./schema"
export * as messages from "./messages"
export * as sessions from "./sessions"
export * as sessionState from "./session-state"
export * as characters from "./characters"
export * as mcpServers from "./mcp-servers"
export * as promptPresets from "./prompt-presets"
export * as settings from "./settings"
export * as skills from "./skills"
export * as skillResources from "./skill-resources"
export * as teams from "./teams"
export * as trustedWorkspaces from "./trusted-workspaces"

// Stub for `DBAgentTrace` referenced by `lib/agent/utils.ts`.
// Cognia stores the raw record as a JSON string (the parser then
// `JSON.parse`s it into an `AgentTraceRecord`); we mirror that shape so
// `parseReplayEvent` typechecks unchanged.
export interface DBAgentTrace {
  id: string
  sessionId: string
  type: string
  timestamp: number
  data?: unknown
  /** Serialized AgentTraceRecord; `JSON.parse` to recover the typed form. */
  record: string
}

// =============================================================================
// `db` and `messageRepository` — plugin-API-shaped surface
//
// The plugin Session API expects a single `db` handle that exposes Dexie
// tables (so it can register `creating` / `updating` / `deleting` hooks)
// and a `messageRepository` with classic CRUD verbs. cognia-next stores
// messages as `StoredMessage` (parts-based) but plugin authors prefer the
// older `content`-based shape; the repository in `./plugin-bridge`
// translates between the two so plugin code doesn't have to know about
// `parts`.
// =============================================================================

export { db, messageRepository } from "./plugin-bridge"
