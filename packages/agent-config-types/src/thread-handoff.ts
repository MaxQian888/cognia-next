// Cross-host thread handoff ticket (ADR-0103).
//
// NAMING: `HandoffEnvelope` in this same package means something else entirely
// — parent→child DELEGATION within one run (ADR-0090 Phase 7). This module is
// about moving one CONVERSATION from one host to another. The types here are
// always `ThreadHandoff*`, never bare `Handoff*`, so the two never blur at an
// import site.
//
// The hard invariant the state machine exists to protect: **there is never more
// than one writable copy of a thread.** The source freezes before anything is
// transmitted, the target materializes frozen, and exactly one commit flips
// exactly one side to writable. Every failure mode resolves toward "fewer
// writable copies", never toward two.
//
// Source and target are different databases on different machines. There is no
// shared transaction and no coordinator, so the honest model is TWO ROWS
// sharing one `ticketId`, distinguished by `role`. Pretending otherwise is
// where designs like this normally break.
//
// Zero-dependency hand-written guards, matching the rest of this package.

import type { SessionFidelity } from "./canonical-session"
import { absolutePathViolation, isNonEmptyString, refViolation } from "./ref-safety"

export const THREAD_HANDOFF_TICKET_VERSION = 1 as const

export type ThreadHandoffState = "preparing" | "frozen" | "accepted" | "committed" | "aborted"

export const THREAD_HANDOFF_STATES: readonly ThreadHandoffState[] = [
  "preparing",
  "frozen",
  "accepted",
  "committed",
  "aborted",
]

/**
 * Legal transitions. Anything absent is a programming error, not a runtime
 * state — `transitionThreadHandoffTicket` throws rather than persisting it.
 *
 * Note `preparing → aborted` is free: nothing is frozen yet, so a failed
 * preflight costs the operator nothing.
 */
export const THREAD_HANDOFF_TRANSITIONS: Readonly<
  Record<ThreadHandoffState, readonly ThreadHandoffState[]>
> = Object.freeze({
  preparing: Object.freeze(["frozen", "aborted"] as const),
  frozen: Object.freeze(["accepted", "aborted"] as const),
  accepted: Object.freeze(["committed", "aborted"] as const),
  committed: Object.freeze([] as const),
  aborted: Object.freeze([] as const),
})

export function canTransition(from: ThreadHandoffState, to: ThreadHandoffState): boolean {
  return THREAD_HANDOFF_TRANSITIONS[from]?.includes(to) ?? false
}

/** Terminal states — no further transition, and the ticket is sweepable. */
export function isTerminalHandoffState(state: ThreadHandoffState): boolean {
  return THREAD_HANDOFF_TRANSITIONS[state]?.length === 0
}

export type ThreadHandoffTransport = "cli-bridge" | "companion" | "remote-host"

export const THREAD_HANDOFF_TRANSPORTS: readonly ThreadHandoffTransport[] = [
  "cli-bridge",
  "companion",
  "remote-host",
]

export type ThreadHandoffRole = "source" | "target"

export type ThreadHandoffHostKind = "desktop" | "cloud" | "mobile" | "cli"

export interface ThreadHandoffHostRef {
  /** "local" for this machine, else a RemoteHost/paired-device id. Never a URL. */
  hostRef: string
  kind: ThreadHandoffHostKind
  label?: string
}

export interface ThreadHandoffProjectMapping {
  sourceProjectId?: string
  /** Logical workspace key the target resolves. NEVER a machine-local path. */
  workspaceRef?: string
  /**
   * Carried as EVIDENCE only, for display and diagnostics. The target resolves
   * its own root from `workspaceRef`; it must never join a path against this.
   */
  sourceWorkingDir?: string
  roots?: Array<{ rootId: string; relPath: string }>
}

export type ThreadHandoffCarriage = "inline" | "chunked" | "by-ref"

export interface ThreadHandoffAttachment {
  attachmentId: string
  filename: string
  mediaType: string
  byteLength: number
  /** SHA-256 hex — integrity plus dedupe against what the target already has. */
  digest: string
  carriage: ThreadHandoffCarriage
  /** by-ref only: a logical ref the target resolves. Never an absolute path. */
  ref?: string
}

/**
 * A permission request that was outstanding when the thread froze.
 *
 * Restore semantics are inherited verbatim from ADR-0090's
 * `CanonicalPermissionEvent`: only `pending` and `denied` may cross. A past
 * `allow` is NEVER transferred and NEVER replayed as an allowance, so a session
 * mid-`allow_always` loses that grant and the tool re-asks on the new host.
 * That is intended, and the UI must say so.
 */
export interface ThreadHandoffPendingApproval {
  requestId: string
  toolName: string
  state: "pending" | "denied"
  requestedAt: number
}

export interface ThreadHandoffRequirements {
  /** `CapabilityId[]` from lib/platform/capabilities — wire format, append-only. */
  capabilities: string[]
  /** Checked with `supportsHostFeatureOperation` against the target manifest. */
  hostOperations: Array<{ feature: string; operation?: string }>
  providerRefs: string[]
  models: string[]
  /** Credential PROFILE refs. Never key material — enforced by ref-safety. */
  credentialProfileRefs: string[]
  minProtocolVersion?: number
}

export interface ThreadHandoffContinuation {
  sourceRuntime: string
  /** Native resume handle where one exists. A BINDING, never an authority. */
  sdkSessionId?: string
  fidelity: SessionFidelity
  /** `computeSequenceDigest` over the turns — detects a mangled transcript. */
  sequenceDigest: string
  /** Rendered pre-handoff context for a non-native resume (branchSeed analogue). */
  seedTranscript?: string
  permissionMode?: string
  systemPrompt?: string
  characterId?: string
  model?: string
  providerOverride?: string
}

export type ThreadHandoffBlockerKind =
  | "capability-missing"
  | "host-operation-missing"
  | "provider-unavailable"
  | "model-unavailable"
  | "credential-missing"
  | "workspace-unavailable"
  | "protocol-incompatible"
  | "attachment-unresolvable"
  | "transcript-digest-mismatch"

export const THREAD_HANDOFF_BLOCKER_KINDS: readonly ThreadHandoffBlockerKind[] = [
  "capability-missing",
  "host-operation-missing",
  "provider-unavailable",
  "model-unavailable",
  "credential-missing",
  "workspace-unavailable",
  "protocol-incompatible",
  "attachment-unresolvable",
  "transcript-digest-mismatch",
]

export interface ThreadHandoffBlocker {
  kind: ThreadHandoffBlockerKind
  ref: string
  /** `blocking` prevents accept; `degraded` accepts with a recorded loss. */
  severity: "blocking" | "degraded"
  detail?: string
}

export interface ThreadHandoffPreflight {
  ok: boolean
  blockers: ThreadHandoffBlocker[]
  /** What the target can actually offer. Never above `continuation.fidelity`. */
  achievableFidelity: SessionFidelity
  checkedAt: number
  targetManifestSchemaVersion?: number
}

export interface ThreadHandoffHistoryEntry {
  state: ThreadHandoffState
  at: number
  note?: string
  actor?: string
}

export interface ThreadHandoffTicket {
  ticketVersion: typeof THREAD_HANDOFF_TICKET_VERSION
  ticketId: string
  state: ThreadHandoffState
  role: ThreadHandoffRole
  source: ThreadHandoffHostRef & {
    sessionId: string
    title: string
    messageCount: number
  }
  target: ThreadHandoffHostRef & { sessionId?: string }
  transport: ThreadHandoffTransport
  project: ThreadHandoffProjectMapping
  requirements: ThreadHandoffRequirements
  continuation: ThreadHandoffContinuation
  attachments: ThreadHandoffAttachment[]
  pendingApprovals: ThreadHandoffPendingApproval[]
  preflight?: ThreadHandoffPreflight
  /** Append-only state-change log — the audit trail of this handoff. */
  history: ThreadHandoffHistoryEntry[]
  createdAt: number
  updatedAt: number
  /**
   * Stranded-ticket watermark. Expiry does NOT auto-unfreeze an `accepted`
   * ticket — that would create a second writable copy. See the sweeper.
   */
  expiresAt: number
}

// ---- Validation --------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function memberOf<T extends string>(value: unknown, members: readonly T[]): value is T {
  return typeof value === "string" && (members as readonly string[]).includes(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

const HOST_KINDS: readonly ThreadHandoffHostKind[] = ["desktop", "cloud", "mobile", "cli"]
const CARRIAGES: readonly ThreadHandoffCarriage[] = ["inline", "chunked", "by-ref"]

function validateHostRef(host: unknown, label: string, errors: string[]): void {
  if (!isPlainObject(host)) {
    errors.push(`${label} is required`)
    return
  }
  if (!isNonEmptyString(host.hostRef)) {
    errors.push(`${label}.hostRef is required`)
  } else {
    const violation = refViolation(host.hostRef)
    if (violation) errors.push(`${label}.hostRef: ${violation}`)
  }
  if (!memberOf(host.kind, HOST_KINDS)) {
    errors.push(`${label}.kind must be a known ThreadHandoffHostKind`)
  }
}

function validateRequirements(reqs: unknown, errors: string[]): void {
  if (!isPlainObject(reqs)) {
    errors.push("requirements is required")
    return
  }
  for (const field of [
    "capabilities",
    "providerRefs",
    "models",
    "credentialProfileRefs",
  ] as const) {
    if (!isStringArray(reqs[field])) errors.push(`requirements.${field} must be a string array`)
  }
  if (!Array.isArray(reqs.hostOperations)) {
    errors.push("requirements.hostOperations must be an array")
  } else {
    for (const [i, op] of reqs.hostOperations.entries()) {
      if (!isPlainObject(op) || !isNonEmptyString(op.feature)) {
        errors.push(`requirements.hostOperations[${i}].feature is required`)
      }
    }
  }
  if (reqs.minProtocolVersion !== undefined && !isFiniteNumber(reqs.minProtocolVersion)) {
    errors.push("requirements.minProtocolVersion must be a finite number")
  }
}

function validateContinuation(cont: unknown, errors: string[]): void {
  if (!isPlainObject(cont)) {
    errors.push("continuation is required")
    return
  }
  if (!isNonEmptyString(cont.sourceRuntime)) errors.push("continuation.sourceRuntime is required")
  if (!isNonEmptyString(cont.fidelity)) errors.push("continuation.fidelity is required")
  if (!isNonEmptyString(cont.sequenceDigest)) {
    errors.push("continuation.sequenceDigest is required")
  }
}

function validateAttachments(attachments: unknown, errors: string[]): void {
  if (!Array.isArray(attachments)) {
    errors.push("attachments must be an array")
    return
  }
  for (const [i, att] of attachments.entries()) {
    if (!isPlainObject(att)) {
      errors.push(`attachments[${i}] must be an object`)
      continue
    }
    if (!isNonEmptyString(att.attachmentId))
      errors.push(`attachments[${i}].attachmentId is required`)
    if (!isNonEmptyString(att.digest)) errors.push(`attachments[${i}].digest is required`)
    if (!isFiniteNumber(att.byteLength) || att.byteLength < 0) {
      errors.push(`attachments[${i}].byteLength must be a non-negative number`)
    }
    if (!memberOf(att.carriage, CARRIAGES)) {
      errors.push(`attachments[${i}].carriage must be a known ThreadHandoffCarriage`)
    }
    if (att.carriage === "by-ref" && !isNonEmptyString(att.ref)) {
      errors.push(`attachments[${i}].ref is required when carriage is "by-ref"`)
    }
  }
}

function validatePendingApprovals(approvals: unknown, errors: string[]): void {
  if (!Array.isArray(approvals)) {
    errors.push("pendingApprovals must be an array")
    return
  }
  for (const [i, approval] of approvals.entries()) {
    if (!isPlainObject(approval)) {
      errors.push(`pendingApprovals[${i}] must be an object`)
      continue
    }
    if (!isNonEmptyString(approval.requestId)) {
      errors.push(`pendingApprovals[${i}].requestId is required`)
    }
    // The ADR-0090 restore rule, enforced structurally: a granted approval
    // cannot even be expressed here, so it cannot be replayed on the target.
    if (approval.state !== "pending" && approval.state !== "denied") {
      errors.push(
        `pendingApprovals[${i}].state must be "pending" or "denied" — a granted approval is never transferred`
      )
    }
  }
}

/** Validate a ticket's shape. Returns violations (empty = valid). */
export function validateThreadHandoffTicket(value: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(value)) return ["ticket must be an object"]
  const ticket = value as Partial<ThreadHandoffTicket>

  if (ticket.ticketVersion !== THREAD_HANDOFF_TICKET_VERSION) {
    errors.push(`ticketVersion must be ${THREAD_HANDOFF_TICKET_VERSION}`)
  }
  if (!isNonEmptyString(ticket.ticketId)) errors.push("ticketId is required")
  if (!memberOf(ticket.state, THREAD_HANDOFF_STATES)) {
    errors.push("state must be a known ThreadHandoffState")
  }
  if (ticket.role !== "source" && ticket.role !== "target") {
    errors.push('role must be "source" or "target"')
  }
  if (!memberOf(ticket.transport, THREAD_HANDOFF_TRANSPORTS)) {
    errors.push("transport must be a known ThreadHandoffTransport")
  }

  validateHostRef(ticket.source, "source", errors)
  if (isPlainObject(ticket.source) && !isNonEmptyString(ticket.source.sessionId)) {
    errors.push("source.sessionId is required")
  }
  validateHostRef(ticket.target, "target", errors)

  if (!isPlainObject(ticket.project)) errors.push("project is required")
  validateRequirements(ticket.requirements, errors)
  validateContinuation(ticket.continuation, errors)
  validateAttachments(ticket.attachments, errors)
  validatePendingApprovals(ticket.pendingApprovals, errors)

  if (!Array.isArray(ticket.history)) errors.push("history must be an array")

  for (const field of ["createdAt", "updatedAt", "expiresAt"] as const) {
    if (!isFiniteNumber(ticket[field])) errors.push(`${field} must be a finite number`)
  }

  return errors
}

export function isThreadHandoffTicket(value: unknown): value is ThreadHandoffTicket {
  return validateThreadHandoffTicket(value).length === 0
}

/**
 * Apply ref-safety to every ref position on a ticket.
 *
 * Separate from {@link validateThreadHandoffTicket} because it answers a
 * different question: not "is this well-formed?" but "does this leak a secret,
 * an endpoint, or a machine-local path across a host boundary?". Callers run
 * both; the transports run this one again on receipt, because the sender is not
 * a trusted validator of its own payload.
 */
export function validateThreadHandoffRefs(ticket: ThreadHandoffTicket): string[] {
  const errors: string[] = []

  const checkRef = (value: string | undefined, label: string, rejectAbsolute: boolean): void => {
    if (value === undefined) return
    const violation = refViolation(value)
    if (violation) errors.push(`${label}: ${violation}`)
    if (rejectAbsolute) {
      const pathViolation = absolutePathViolation(value)
      if (pathViolation) errors.push(`${label}: ${pathViolation}`)
    }
  }

  checkRef(ticket.source.hostRef, "source.hostRef", false)
  checkRef(ticket.target.hostRef, "target.hostRef", false)
  // A workspace ref must survive a host boundary; an absolute path does not.
  checkRef(ticket.project.workspaceRef, "project.workspaceRef", true)

  for (const [i, ref] of ticket.requirements.credentialProfileRefs.entries()) {
    checkRef(ref, `requirements.credentialProfileRefs[${i}]`, false)
  }

  for (const [i, att] of ticket.attachments.entries()) {
    checkRef(att.ref, `attachments[${i}].ref`, true)
  }

  return errors
}
