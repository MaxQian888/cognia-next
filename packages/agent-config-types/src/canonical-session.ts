// Canonical session contract (ADR-0090 Phase 8).
//
// The runtime-neutral representation every session codec converts INTO
// (import) and, where a public runtime path exists, OUT OF (materialize).
// The canonical LOG is the AgentEventEnvelope stream on the durable workflow
// event-log; this module defines the SESSION-level record (header + turns +
// permissions + checkpoints), the five-level fidelity scale, and the honest
// loss report every conversion must return. Zero dependencies; hand-written
// guards like the rest of this package.

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
}

export interface CanonicalTurn {
  turnId: string
  role: "user" | "assistant" | "system"
  text: string
  toolCalls?: CanonicalToolCall[]
  /** ISO timestamp when the source recorded one. */
  at?: string
  usage?: { inputTokens?: number; outputTokens?: number }
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
  /**
   * Native runtime handle when one exists. A BINDING only (used for
   * native resume when the runtime still has the session) — never authority
   * over content; the canonical turns are.
   */
  runtimeBinding?: { nativeSessionId?: string }
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

export interface CanonicalSession {
  header: CanonicalSessionHeader
  turns: CanonicalTurn[]
  permissions?: CanonicalPermissionEvent[]
  checkpoints?: CanonicalCheckpoint[]
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
  for (const turn of turns) {
    feed(turn.role)
    feed("")
    feed(turn.text)
    for (const call of turn.toolCalls ?? []) {
      feed("")
      feed(call.toolName)
      feed("")
      feed(call.callId)
    }
    feed("")
  }
  return `seq1-${hash.toString(16).padStart(8, "0")}`
}

// ---- Validation -------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

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

  return errors
}

export function isCanonicalSession(value: unknown): value is CanonicalSession {
  return validateCanonicalSession(value).length === 0
}
