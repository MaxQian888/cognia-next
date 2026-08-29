// Canonical session contract (ADR-0090 Phase 8).
//
// The runtime-neutral representation every session codec converts INTO
// (import) and, where a public runtime path exists, OUT OF (materialize).
// The canonical LOG is the AgentEventEnvelope stream on the durable workflow
// event-log; this module defines the SESSION-level record (header + turns +
// permissions + checkpoints), the five-level fidelity scale, and the honest
// loss report every conversion must return. Zero dependencies; hand-written
// guards like the rest of this package.

import { isNonEmptyString } from "./ref-safety"
import type { CanonicalAgentEvent, CanonicalContentPart } from "./agent-execution"

export type SessionFidelity =
  "native-exact" | "structured" | "contextual" | "summary-only" | "unsupported"

export const SESSION_FIDELITY_LEVELS: readonly SessionFidelity[] = [
  "native-exact",
  "structured",
  "contextual",
  "summary-only",
  "unsupported",
]

/** Higher = more faithful. Used by the recovery planner's dominance check. */
export function fidelityRank(fidelity: SessionFidelity): number {
  const index = SESSION_FIDELITY_LEVELS.indexOf(fidelity)
  return index === -1 ? -1 : SESSION_FIDELITY_LEVELS.length - 1 - index
}

export interface CanonicalToolCall {
  callId: string
  toolName: string
  /** JSON-safe input snapshot (may be truncated by the codec — report it). */
  input?: Record<string, unknown>
  resultText?: string
  isError?: boolean
  status?: "pending" | "running" | "completed" | "failed" | "cancelled"
  startedAt?: string
  endedAt?: string
  parentToolCallId?: string
  taskId?: string
  attachments?: CanonicalContentPart[]
}

export interface CanonicalTurnUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cachedOutputTokens?: number
  reasoningTokens?: number
  toolTokens?: number
  totalTokens?: number
  costUsd?: number
}

export interface CanonicalTurn {
  turnId: string
  role: "user" | "assistant" | "system"
  text: string
  reasoning?: string
  parts?: CanonicalContentPart[]
  toolCalls?: CanonicalToolCall[]
  model?: string
  status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
  /** ISO timestamp when the source recorded one. */
  at?: string
  usage?: CanonicalTurnUsage
}

export interface CanonicalPermissionEvent {
  requestId: string
  toolName: string
  /**
   * Terminal decision recorded by the source. Restore semantics (ADR-0090):
   * only `pending` and `denied` states may be re-surfaced; a past `allow` is
   * NEVER replayed as an allowance.
   */
  decision: "allow" | "allow_always" | "deny" | "pending"
  at?: string
}

export interface CanonicalCheckpoint {
  checkpointId: string
  /** The turn this checkpoint sits AFTER. */
  afterTurnId: string
  note?: string
}

export interface CanonicalSessionHeader {
  canonicalVersion: 1
  /** Our stable id — never the runtime's private id. */
  canonicalSessionId: string
  /** Source adapter/runtime id ("claude-code" | "codex" | "opencode" | …). */
  sourceRuntime: string
  /** Versioned provenance of the source artifact used for this conversion. */
  source?: {
    format?: string
    version?: string
    revision?: string
    verifiedAt?: string
  }
  /**
   * Native runtime handle when one exists. A BINDING only (used for
   * native resume when the runtime still has the session) — never authority
   * over content; the canonical turns are.
   */
  runtimeBinding?: {
    nativeSessionId?: string
    presetId?: string
    cwd?: string
    resumeMethod?: "protocol" | "cli" | "api" | "contextual"
    verifiedAt?: string
  }
  lineage?: CanonicalSessionLineage
  lifecycle?: CanonicalSessionLifecycle
  title?: string
  createdAt: string
  updatedAt: string
  turnCount: number
  /** Fidelity of the IMPORT conversion that produced this record. */
  importFidelity: SessionFidelity
  /**
   * Deterministic digest over the shared turn sequence. Two candidates that
   * disagree on the digest of their COMMON prefix have forked — the planner
   * must not auto-pick between them.
   */
  sequenceDigest: string
}

export type CanonicalSessionRelationKind =
  "branch" | "fork" | "subagent" | "background" | "team-member"

export interface CanonicalSessionLineage {
  kind: CanonicalSessionRelationKind
  parentCanonicalSessionId?: string
  parentNativeSessionId?: string
  rootCanonicalSessionId?: string
  parentToolCallId?: string
  taskId?: string
}

export type CanonicalSessionLifecycleStatus =
  "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted"

export interface CanonicalSessionLifecycle {
  status: CanonicalSessionLifecycleStatus
  background?: boolean
  startedAt?: string
  updatedAt?: string
  endedAt?: string
  error?: string
}

export interface CanonicalSessionTask {
  taskId: string
  description?: string
  status: CanonicalSessionLifecycleStatus
  background?: boolean
  toolCallId?: string
  parentTaskId?: string
  dependencies?: string[]
  childCanonicalSessionId?: string
  summary?: string
  error?: string
  startedAt?: string
  endedAt?: string
}

export interface CanonicalSessionPlan {
  planId: string
  status?: "draft" | "active" | "completed" | "cancelled"
  title?: string
  steps: string[]
  updatedAt?: string
}

export interface CanonicalSessionGoal {
  goalId: string
  description: string
  status?: "active" | "completed" | "cancelled" | "blocked"
  updatedAt?: string
}

export interface CanonicalHistoryEvent {
  historyId: string
  kind: "branch" | "fork" | "rewind" | "rollback" | "compaction"
  at?: string
  fromTurnId?: string
  toTurnId?: string
  summary?: string
}

export interface CanonicalInterAgentMessage {
  messageId: string
  fromSessionId: string
  toSessionId?: string
  text: string
  at?: string
}

/** A source event without a synthetic run/host envelope. */
export interface CanonicalRecordedEvent {
  eventId: string
  sequence: number
  turnId?: string
  at?: string
  event: CanonicalAgentEvent
}

export interface CanonicalSession {
  header: CanonicalSessionHeader
  turns: CanonicalTurn[]
  permissions?: CanonicalPermissionEvent[]
  checkpoints?: CanonicalCheckpoint[]
  tasks?: CanonicalSessionTask[]
  plans?: CanonicalSessionPlan[]
  goals?: CanonicalSessionGoal[]
  history?: CanonicalHistoryEvent[]
  interAgentMessages?: CanonicalInterAgentMessage[]
  recordedEvents?: CanonicalRecordedEvent[]
}

// ---- Loss report ------------------------------------------------------------

export interface SessionLossEntry {
  /** Dot path of what was affected ("turns[3].toolCalls", "thinking"). */
  path: string
  kind: "dropped" | "approximated" | "summarized"
  detail?: string
}

/** Honest conversion outcome — every codec conversion returns one. */
export interface SessionLossReport {
  fidelity: SessionFidelity
  losses: SessionLossEntry[]
  /** True when the artifact was RECONSTRUCTED from trusted evidence. */
  rebuilt?: boolean
}

// ---- Digest -----------------------------------------------------------------

/**
 * Deterministic FNV-1a-32 (hex) over the turn sequence (role + text + tool
 * call ids/names, joined with unit separators). Same turns ⇒ same digest on
 * every host; volatile fields (timestamps, usage) are excluded.
 */
export function computeSequenceDigest(turns: readonly CanonicalTurn[]): string {
  let hash = 0x811c9dc5
  const feed = (s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  const stableJson = (value: unknown): string => {
    const seen = new WeakSet<object>()
    const normalize = (input: unknown): unknown => {
      if (!input || typeof input !== "object") return input
      if (seen.has(input)) return "[Circular]"
      seen.add(input)
      if (Array.isArray(input)) return input.map(normalize)
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)])
      )
    }
    try {
      return JSON.stringify(normalize(value))
    } catch {
      return String(value)
    }
  }
  for (const turn of turns) {
    feed(turn.role)
    feed("")
    feed(turn.text)
    feed("\u001c")
    feed(turn.reasoning ?? "")
    feed("\u001c")
    feed(turn.model ?? "")
    feed("\u001c")
    feed(turn.status ?? "")
    if (turn.parts) {
      feed("\u001b")
      feed(stableJson(turn.parts))
    }
    for (const call of turn.toolCalls ?? []) {
      feed("")
      feed(call.toolName)
      feed("")
      feed(call.callId)
      feed("\u001f")
      feed(call.status ?? "")
      feed("\u001f")
      feed(stableJson(call.input ?? null))
      feed("\u001f")
      feed(call.resultText ?? "")
      feed("\u001f")
      feed(call.isError ? "1" : "0")
      feed("\u001f")
      feed(stableJson(call.attachments ?? []))
    }
    feed("")
  }
  return `seq1-${hash.toString(16).padStart(8, "0")}`
}

// ---- Validation -------------------------------------------------------------

/** Validate a canonical session. Returns violations (empty = valid). */
export function validateCanonicalSession(value: unknown): string[] {
  const errors: string[] = []
  if (!value || typeof value !== "object") return ["canonical session must be an object"]
  const session = value as Partial<CanonicalSession>

  const header = session.header
  if (!header || typeof header !== "object") {
    errors.push("header is required")
  } else {
    if (header.canonicalVersion !== 1) errors.push("header.canonicalVersion must be 1")
    if (!isNonEmptyString(header.canonicalSessionId)) {
      errors.push("header.canonicalSessionId is required")
    }
    if (!isNonEmptyString(header.sourceRuntime)) errors.push("header.sourceRuntime is required")
    if (!SESSION_FIDELITY_LEVELS.includes(header.importFidelity as SessionFidelity)) {
      errors.push("header.importFidelity must be a known fidelity level")
    }
    if (!isNonEmptyString(header.sequenceDigest)) errors.push("header.sequenceDigest is required")

    if (header.lineage) {
      const kinds: readonly CanonicalSessionRelationKind[] = [
        "branch",
        "fork",
        "subagent",
        "background",
        "team-member",
      ]
      if (!kinds.includes(header.lineage.kind)) errors.push("header.lineage.kind is invalid")
      for (const key of [
        "parentCanonicalSessionId",
        "parentNativeSessionId",
        "rootCanonicalSessionId",
        "parentToolCallId",
        "taskId",
      ] as const) {
        if (header.lineage[key] !== undefined && !isNonEmptyString(header.lineage[key])) {
          errors.push(`header.lineage.${key} must be non-empty when present`)
        }
      }
    }
    if (
      header.lifecycle &&
      ![
        "pending",
        "running",
        "waiting",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
      ].includes(header.lifecycle.status)
    ) {
      errors.push("header.lifecycle.status is invalid")
    }
  }

  if (!Array.isArray(session.turns)) {
    errors.push("turns must be an array")
  } else {
    for (const [i, turn] of session.turns.entries()) {
      if (!turn || !isNonEmptyString(turn.turnId)) errors.push(`turns[${i}].turnId is required`)
      if (turn && !["user", "assistant", "system"].includes(turn.role)) {
        errors.push(`turns[${i}].role is invalid`)
      }
      if (turn && typeof turn.text !== "string") errors.push(`turns[${i}].text must be a string`)
    }
    if (
      session.header &&
      typeof session.header.turnCount === "number" &&
      session.header.turnCount !== session.turns.length
    ) {
      errors.push("header.turnCount disagrees with turns.length")
    }
    if (
      session.header &&
      isNonEmptyString(session.header.sequenceDigest) &&
      session.header.sequenceDigest !== computeSequenceDigest(session.turns as CanonicalTurn[])
    ) {
      errors.push("header.sequenceDigest disagrees with the turn sequence")
    }
  }

  for (const [i, permission] of (session.permissions ?? []).entries()) {
    if (!permission || !isNonEmptyString(permission.requestId)) {
      errors.push(`permissions[${i}].requestId is required`)
      continue
    }
    if (!["allow", "allow_always", "deny", "pending"].includes(permission.decision)) {
      errors.push(`permissions[${i}].decision is invalid`)
    }
  }

  for (const [i, task] of (session.tasks ?? []).entries()) {
    if (!task || !isNonEmptyString(task.taskId)) errors.push(`tasks[${i}].taskId is required`)
  }

  for (const [i, event] of (session.recordedEvents ?? []).entries()) {
    if (!event || !isNonEmptyString(event.eventId)) {
      errors.push(`recordedEvents[${i}].eventId is required`)
    }
    if (!event || !Number.isInteger(event.sequence) || event.sequence < 0) {
      errors.push(`recordedEvents[${i}].sequence must be a non-negative integer`)
    }
    if (!event?.event || !isNonEmptyString(event.event.kind)) {
      errors.push(`recordedEvents[${i}].event.kind is required`)
    }
  }

  return errors
}

export function isCanonicalSession(value: unknown): value is CanonicalSession {
  return validateCanonicalSession(value).length === 0
}
