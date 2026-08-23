/**
 * Versioned capability identifiers, shared by the client and the host.
 *
 * The previous list was sixteen bare strings declared unconditionally, which
 * told a caller nothing it could act on: `sandbox-policy-snapshots` reads like
 * a filesystem checkpoint and is a policy record, and `event-replay` said
 * nothing about whether the host could bound a replay with a head cursor.
 *
 * Two rules apply to everything here:
 *
 * 1. Every identifier carries a version suffix. A behavioural change to a
 *    capability mints `-v2`; it never redefines `-v1` in place.
 * 2. A host declares a capability only when the selected backend actually
 *    supports it. Declaring it unconditionally is what made the old list
 *    unusable.
 */

/** Canonical session records with fork/clone/import/export. */
export const CAP_SESSIONS_V1 = "sessions-v1"
/** `session/entries` returns `headEventId`, so replay can be cursor-bounded. */
export const CAP_EVENT_REPLAY_V2 = "event-replay-v2"
/** Duplicate `commandId` returns the original receipt instead of re-executing. */
export const CAP_COMMAND_RECEIPTS_V1 = "command-receipts-v1"
/** More than one session may be open, and turns may run on them concurrently. */
export const CAP_CONCURRENT_SESSIONS_V1 = "concurrent-sessions-v1"
/** Provider session affinity survives a host restart. */
export const CAP_DURABLE_PROVIDER_SESSION_V1 = "durable-provider-session-v1"
/** Tool-call permission prompts are durable and settleable over RPC. */
export const CAP_PERMISSIONS_V1 = "permissions-v1"
/** Structured elicitation prompts are durable and settleable over RPC. */
export const CAP_ELICITATION_V1 = "elicitation-v1"
/** Host-suspended external tool calls are settleable over RPC. */
export const CAP_EXTERNAL_TOOLS_V1 = "external-tools-v1"
/** Client-registered tools invoked back over `client/tool/invoke`. */
export const CAP_CLIENT_TOOLS_V1 = "client-tools-v1"
/** Client-registered hooks invoked back over `client/hook/invoke`. */
export const CAP_CLIENT_HOOKS_V1 = "client-hooks-v1"
/**
 * Client hook and tool invocations are attributed to the session that actually
 * triggered them, rather than to whichever session happened to be busy.
 */
export const CAP_CALLBACK_ATTRIBUTION_V1 = "callback-attribution-v1"
/** MCP server lifecycle and status. */
export const CAP_MCP_V1 = "mcp-v1"
/** Plugin reload. */
export const CAP_PLUGINS_V1 = "plugins-v1"
/** Skill reload. */
export const CAP_SKILLS_V1 = "skills-v1"
/** Background task listing and control. */
export const CAP_TASKS_V1 = "tasks-v1"
/**
 * Sandbox *policy* records. Deliberately not named "snapshot": this captures
 * the resource policy in force, not the contents of the workspace. A real
 * filesystem checkpoint is `workspace-checkpoint-v1` and is a separate claim.
 */
export const CAP_SANDBOX_POLICY_V1 = "sandbox-policy-v1"
/** Filesystem checkpoint and restore. Declared only by a backend that has it. */
export const CAP_WORKSPACE_CHECKPOINT_V1 = "workspace-checkpoint-v1"
/** Trace spans, redacted by default. */
export const CAP_TRACES_REDACTED_V1 = "traces-redacted-v1"
/** `trace/unsubscribe` exists, so a subscription can be released. */
export const CAP_TRACE_UNSUBSCRIBE_V1 = "trace-unsubscribe-v1"
/** Durable audit log with cursor paging. */
export const CAP_AUDIT_DURABLE_V1 = "audit-durable-v1"
/**
 * Compaction undo against a live in-memory pre-compaction snapshot. Single-use
 * and never simulated after a host restart.
 */
export const CAP_COMPACTION_UNDO_LIVE_V1 = "compaction-undo-live-v1"
/** `session/forest` returns every root; `session/tree` returns one subtree. */
export const CAP_SESSION_FOREST_V1 = "session-forest-v1"
/** Remote handoff to a worker host. */
export const CAP_WORKER_DISPATCH_V1 = "worker-dispatch-v1"
/** Host-persisted, immutable, versioned agent definitions (`agent/*`). */
export const CAP_AGENT_DEFINITIONS_V1 = "agent-definitions-v1"
/** Turn results validated against a definition's output schema. */
export const CAP_STRUCTURED_OUTPUT_V1 = "structured-output-v1"
/** Tool contracts carry a schema digest the host preflights before each call. */
export const CAP_TYPED_TOOLS_V1 = "typed-tools-v1"
/** `session/create({ agent })` freezes the resolved version into the session. */
export const CAP_AGENT_SESSION_BINDING_V1 = "agent-session-binding-v1"
/** Content-addressed asset upload; turns reference assets by id. */
export const CAP_ASSETS_V1 = "assets-v1"
/** The client can re-attach after a transport drop and replay from a cursor. */
export const CAP_RECONNECT_V1 = "reconnect-v1"

/** Capabilities the SDK itself offers the host during `initialize`. */
export const CLIENT_CAPABILITIES = [
  CAP_CLIENT_TOOLS_V1,
  CAP_CLIENT_HOOKS_V1,
  CAP_EVENT_REPLAY_V2,
  CAP_RECONNECT_V1,
] as const

export type ClientCapability = (typeof CLIENT_CAPABILITIES)[number]

const VERSIONED = /^[a-z][a-z0-9-]*-v(\d+)$/

/** Every identifier must be lowercase-kebab and end in a version suffix. */
export function isVersionedCapability(value: string): boolean {
  return VERSIONED.test(value)
}

/** `"event-replay-v2"` -> `{ name: "event-replay", version: 2 }`. */
export function parseCapability(value: string): { name: string; version: number } | undefined {
  const match = VERSIONED.exec(value)
  if (!match) return undefined
  return { name: value.slice(0, value.length - match[1]!.length - 2), version: Number(match[1]) }
}

/**
 * True when `declared` contains `required` at that exact version.
 *
 * Deliberately exact rather than ">= version": a `-v2` capability is a
 * different contract from `-v1`, not a superset of it, so a host that only
 * declares `-v2` must not silently satisfy a caller written against `-v1`.
 */
export function hasCapability(declared: readonly string[], required: string): boolean {
  return declared.includes(required)
}
