/**
 * WorkSubmissionV1 — durable work submission and immutable input ownership
 * (ADR-0123).
 *
 * The contract encodes one rule: **work a user can see is persisted before it
 * is dispatched, and what was persisted is what runs.** Every field here exists
 * to make a retry replay the *original* intent rather than re-derive it from
 * whatever the session looks like now.
 *
 * Three frozen objects, each with its own lifetime:
 *
 *   • {@link WorkSubmissionIntentV1}  — why the work exists and who may run it.
 *   • {@link WorkInputBatchRefV1}     — the exact model-side input, by digest.
 *   • {@link ExecutionContextRefV1}   — the execution surroundings, by digest.
 *
 * Input and context deliberately freeze at *different* moments: the model-side
 * content is final as soon as prompt hooks and redaction have run, while the
 * execution context (working directory, task workspace, route) is not settled
 * until immediately before dispatch. Modelling them as one object would force
 * a single freeze point that is wrong for one of them, so this contract carries
 * them as two independently-digested refs bound to the same submission.
 *
 * Payloads never appear here. This type is the *envelope* that crosses process
 * and host boundaries; the plaintext it describes lives encrypted at rest on
 * the executing host and is addressed only by id + digest. That is why every
 * string field is pushed through the ref-safety guards — a leaking payload
 * becomes a validation error at the boundary instead of a code-review hope.
 */

import type { AgentExecutionSurface } from "./agent-execution"
import {
  absolutePathViolation,
  hasOnlyKeys,
  isNonEmptyString,
  isNonNegativeInteger,
  isRecord,
  refViolation,
} from "./ref-safety"

export const WORK_SUBMISSION_CONTRACT_VERSION = 1 as const

/**
 * Where a submission came from.
 *
 * Deliberately an alias rather than a new enum: `AgentExecutionSurface` already
 * names every producer, and this package already carries two overlapping
 * lineage enums (`ExecutionRunKind`, `AgentRunKind`). A fourth would guarantee
 * drift at the seams where they meet.
 */
export type WorkSourceKind = AgentExecutionSurface

/**
 * What to do when the chosen execution target is not available *right now*.
 *
 *   • `wait`    — hold the submission until the target returns (interactive work).
 *   • `skip`    — drop this occurrence; a later one will come (periodic work).
 *   • `fail`    — surface an error to the caller that is waiting on a result.
 *   • `degrade` — fall back to a lesser rail, only where that is provably safe.
 *
 * `degrade` is never a default. It is only sound when the work declares no hard
 * capability requirement and performs no irreversible action, because the
 * fallback rail cannot honour guarantees the primary rail was chosen for.
 */
export type WorkAvailabilityPolicyV1 = "wait" | "skip" | "fail" | "degrade"

/**
 * Dispatch responsibility — *not* user-visible lifecycle.
 *
 * `ExecutionRun.status` remains the single authority for "what is happening to
 * this work" (`queued`/`running`/`completed`/…). This enum answers only "who
 * currently owes a dispatch attempt". Keeping the two apart is what stops a
 * terminal product state and a terminal queue state from disagreeing.
 *
 *   pending → blocked → pending → claimed → dispatched → settled
 *             └────────────────────────────────────────→ settled
 */
export type WorkDispatchStateV1 = "pending" | "blocked" | "claimed" | "dispatched" | "settled"

/**
 * Whether the frozen execution spec actually governed routing.
 *
 * While the unified resolver is still rolling out (ADR-0090), a submission may
 * carry a spec that was resolved for observation only, with dispatch still
 * flowing through the legacy path. Recording which is the case prevents the
 * spec being read back as authoritative routing evidence it never was.
 */
export type WorkSpecAuthorityV1 = "shadow" | "authoritative"

/** How a submission stopped. `no_response` is a *successful* empty turn. */
export type WorkTerminalOutcomeV1 =
  "completed" | "no_response" | "failed" | "cancelled" | "recovery_required"

/** Maximum inline text carried anywhere in a submission envelope. */
export const WORK_SUBMISSION_MAX_INLINE_TEXT_BYTES = 256 * 1024
/** Maximum size of a whole serialized submission envelope. */
export const WORK_SUBMISSION_MAX_ENVELOPE_BYTES = 512 * 1024

/**
 * An attachment, by reference only.
 *
 * Bytes are content-addressed and stored out of band; the envelope carries
 * enough to fetch and verify them and nothing more. `fileName` is a display
 * name, never a path — see the guard.
 */
export interface WorkAttachmentRefV1 {
  assetId: string
  /** Lowercase hex SHA-256 of the asset bytes. */
  digest: string
  mediaType: string
  size: number
  fileName: string
}

/**
 * Reference to the frozen model-side input.
 *
 * The batch itself (message content, resolved attachments, private workbench
 * context) is encrypted at rest and addressed by id. `digest` is what makes a
 * retry provable: the same submission replayed must resolve to the same digest,
 * or the input was re-derived rather than replayed.
 */
export interface WorkInputBatchRefV1 {
  inputBatchId: string
  digest: string
  /** Message ids visible in the transcript, in send order. */
  visibleMessageIds: string[]
  attachments: WorkAttachmentRefV1[]
}

/**
 * Reference to the frozen execution context.
 *
 * Logical refs only — the project revision, workspace binding and base ref that
 * let a host re-materialize the same surroundings. Absolute paths stay on the
 * executing host, enforced structurally by {@link absolutePathViolation}.
 */
export interface ExecutionContextRefV1 {
  contextBundleId: string
  digest: string
  projectId?: string
  /** Logical workspace binding ref, never a filesystem path. */
  workspaceBindingRef?: string
  baseRef?: string
}

/** Identity of the work, and the account/target boundary it may not cross. */
export interface WorkScopeV1 {
  accountId: string
  runtimeTargetId: string
  sessionId?: string
  projectId?: string
}

/** Which business object this work reports back into, if any. */
export interface WorkItemRefV1 {
  kind: "agent-task" | "goal" | "workflow-run" | "team-task"
  id: string
}

export interface WorkSourceV1 {
  kind: WorkSourceKind
  sourceId: string
  triggerId?: string
}

/**
 * The submission envelope.
 *
 * `idempotencyKey` is unique per account. Re-submitting the same key returns
 * the original receipt rather than creating a second message, run, or task —
 * which is what makes at-least-once delivery from a client outbox safe.
 */
export interface WorkSubmissionIntentV1 {
  contractVersion: typeof WORK_SUBMISSION_CONTRACT_VERSION
  idempotencyKey: string
  source: WorkSourceV1
  scope: WorkScopeV1
  availabilityPolicy: WorkAvailabilityPolicyV1
  workItemRef?: WorkItemRefV1
}

/** What the caller gets back the moment work is durably accepted. */
export interface WorkReceiptV1 {
  contractVersion: typeof WORK_SUBMISSION_CONTRACT_VERSION
  submissionId: string
  runId: string
  turnId: string
  inputBatchId: string
  state: "accepted" | "blocked" | "queued" | "terminal"
  acceptedAt: number
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/**
 * Runtime membership tables, declared as `Record<Union, true>` rather than
 * arrays on purpose: a `Record` keyed by the union is only satisfiable when
 * every member is present, so adding a case to `AgentExecutionSurface` (which
 * lives in another module) breaks the build here instead of silently making
 * this guard reject a legitimate new surface at runtime.
 */
const SOURCE_KINDS: Record<WorkSourceKind, true> = {
  chat: true,
  connector: true,
  "agent-executor": true,
  "workflow-agent-turn": true,
  team: true,
  plugin: true,
  cli: true,
}

const AVAILABILITY_POLICIES: Record<WorkAvailabilityPolicyV1, true> = {
  wait: true,
  skip: true,
  fail: true,
  degrade: true,
}

const WORK_ITEM_KINDS: Record<WorkItemRefV1["kind"], true> = {
  "agent-task": true,
  goal: true,
  "workflow-run": true,
  "team-task": true,
}

function isMemberOf<T extends string>(table: Record<T, true>, value: unknown): value is T {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(table, value)
}

const SHA256_HEX = /^[0-9a-f]{64}$/
/** Path separators and traversal segments have no place in a display name. */
const UNSAFE_FILE_NAME = /[/\\]|^\.{1,2}$|\0/

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Reject a string that is empty, oversized, secret-shaped, URL-shaped, or a
 * machine-local absolute path. Every ref-position string in this contract goes
 * through here, so a leak is a validation failure rather than a silent forward.
 */
function refFieldViolation(label: string, value: unknown): string | null {
  if (!isNonEmptyString(value)) return `${label} must be a non-empty string`
  if (utf8Bytes(value) > WORK_SUBMISSION_MAX_INLINE_TEXT_BYTES) {
    return `${label} exceeds the inline text budget`
  }
  const unsafe = refViolation(value) ?? absolutePathViolation(value)
  return unsafe ? `${label}: ${unsafe}` : null
}

function collectRefFields(
  errors: string[],
  fields: ReadonlyArray<readonly [string, unknown]>
): void {
  for (const [label, value] of fields) {
    const violation = refFieldViolation(label, value)
    if (violation) errors.push(violation)
  }
}

function optionalRefField(errors: string[], label: string, value: unknown): void {
  if (value === undefined) return
  const violation = refFieldViolation(label, value)
  if (violation) errors.push(violation)
}

export function isWorkAttachmentRefV1(value: unknown): value is WorkAttachmentRefV1 {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, ["assetId", "digest", "mediaType", "size", "fileName"])) return false
  return (
    refFieldViolation("assetId", value.assetId) === null &&
    typeof value.digest === "string" &&
    SHA256_HEX.test(value.digest) &&
    isNonEmptyString(value.mediaType) &&
    isNonNegativeInteger(value.size) &&
    isNonEmptyString(value.fileName) &&
    !UNSAFE_FILE_NAME.test(value.fileName) &&
    absolutePathViolation(value.fileName) === null
  )
}

export function isWorkInputBatchRefV1(value: unknown): value is WorkInputBatchRefV1 {
  if (!isRecord(value)) return false
  if (!hasOnlyKeys(value, ["inputBatchId", "digest", "visibleMessageIds", "attachments"])) {
    return false
  }
  return (
    refFieldViolation("inputBatchId", value.inputBatchId) === null &&
    isNonEmptyString(value.digest) &&
    Array.isArray(value.visibleMessageIds) &&
    value.visibleMessageIds.every((id) => refFieldViolation("visibleMessageId", id) === null) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isWorkAttachmentRefV1)
  )
}

export function isExecutionContextRefV1(value: unknown): value is ExecutionContextRefV1 {
  if (!isRecord(value)) return false
  if (
    !hasOnlyKeys(value, [
      "contextBundleId",
      "digest",
      "projectId",
      "workspaceBindingRef",
      "baseRef",
    ])
  ) {
    return false
  }
  const errors: string[] = []
  collectRefFields(errors, [["contextBundleId", value.contextBundleId]])
  optionalRefField(errors, "projectId", value.projectId)
  optionalRefField(errors, "workspaceBindingRef", value.workspaceBindingRef)
  optionalRefField(errors, "baseRef", value.baseRef)
  return errors.length === 0 && isNonEmptyString(value.digest)
}

function validateSource(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("source must be an object")
    return
  }
  if (!hasOnlyKeys(value, ["kind", "sourceId", "triggerId"])) {
    errors.push("source carries unknown fields")
    return
  }
  if (!isMemberOf(SOURCE_KINDS, value.kind)) {
    errors.push("source.kind is not a known work source")
  }
  collectRefFields(errors, [["source.sourceId", value.sourceId]])
  optionalRefField(errors, "source.triggerId", value.triggerId)
}

function validateScope(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push("scope must be an object")
    return
  }
  if (!hasOnlyKeys(value, ["accountId", "runtimeTargetId", "sessionId", "projectId"])) {
    errors.push("scope carries unknown fields")
    return
  }
  collectRefFields(errors, [
    ["scope.accountId", value.accountId],
    ["scope.runtimeTargetId", value.runtimeTargetId],
  ])
  optionalRefField(errors, "scope.sessionId", value.sessionId)
  optionalRefField(errors, "scope.projectId", value.projectId)
}

function validateWorkItemRef(value: unknown, errors: string[]): void {
  if (value === undefined) return
  if (!isRecord(value)) {
    errors.push("workItemRef must be an object")
    return
  }
  if (!hasOnlyKeys(value, ["kind", "id"])) {
    errors.push("workItemRef carries unknown fields")
    return
  }
  if (!isMemberOf(WORK_ITEM_KINDS, value.kind)) {
    errors.push("workItemRef.kind is not a known work item")
  }
  collectRefFields(errors, [["workItemRef.id", value.id]])
}

/**
 * Validate a submission envelope, fail-closed.
 *
 * Unknown fields, unknown sources, oversized envelopes, and any ref-position
 * string that looks like a secret, a URL, or a host-local absolute path are all
 * rejected. Cross-account and cross-target consistency cannot be judged from
 * the envelope alone and is enforced by the repository at write time.
 */
export function validateWorkSubmissionIntentV1(
  value: unknown
): ValidationResult<WorkSubmissionIntentV1> {
  const errors: string[] = []
  if (!isRecord(value)) return { ok: false, errors: ["submission must be an object"] }
  if (
    !hasOnlyKeys(value, [
      "contractVersion",
      "idempotencyKey",
      "source",
      "scope",
      "availabilityPolicy",
      "workItemRef",
    ])
  ) {
    errors.push("submission carries unknown fields")
  }
  if (value.contractVersion !== WORK_SUBMISSION_CONTRACT_VERSION) {
    errors.push("unsupported work submission contract version")
  }
  collectRefFields(errors, [["idempotencyKey", value.idempotencyKey]])
  validateSource(value.source, errors)
  validateScope(value.scope, errors)
  if (!isMemberOf(AVAILABILITY_POLICIES, value.availabilityPolicy)) {
    errors.push("availabilityPolicy is not a known policy")
  }
  validateWorkItemRef(value.workItemRef, errors)

  if (errors.length === 0) {
    // Size is checked last: an envelope that is already invalid gets the more
    // useful structural error rather than a byte count.
    const serialized = JSON.stringify(value)
    if (utf8Bytes(serialized) > WORK_SUBMISSION_MAX_ENVELOPE_BYTES) {
      errors.push("submission envelope exceeds the size budget")
    }
  }

  return errors.length === 0
    ? { ok: true, value: value as unknown as WorkSubmissionIntentV1 }
    : { ok: false, errors }
}

export function isWorkSubmissionIntentV1(value: unknown): value is WorkSubmissionIntentV1 {
  return validateWorkSubmissionIntentV1(value).ok
}

export function isWorkReceiptV1(value: unknown): value is WorkReceiptV1 {
  if (!isRecord(value)) return false
  if (
    !hasOnlyKeys(value, [
      "contractVersion",
      "submissionId",
      "runId",
      "turnId",
      "inputBatchId",
      "state",
      "acceptedAt",
    ])
  ) {
    return false
  }
  return (
    value.contractVersion === WORK_SUBMISSION_CONTRACT_VERSION &&
    isNonEmptyString(value.submissionId) &&
    isNonEmptyString(value.runId) &&
    isNonEmptyString(value.turnId) &&
    isNonEmptyString(value.inputBatchId) &&
    (value.state === "accepted" ||
      value.state === "blocked" ||
      value.state === "queued" ||
      value.state === "terminal") &&
    isNonNegativeInteger(value.acceptedAt)
  )
}

/**
 * Whether a submission in this dispatch state may still be claimed by a runner.
 *
 * `blocked` is claimable: the target being unavailable is exactly the condition
 * a later sweep is meant to re-test.
 */
export function isClaimableDispatchState(state: WorkDispatchStateV1): boolean {
  return state === "pending" || state === "blocked"
}

/** Terminal outcomes that represent a turn the user got an answer from. */
export function isSuccessfulOutcome(outcome: WorkTerminalOutcomeV1): boolean {
  return outcome === "completed" || outcome === "no_response"
}

/**
 * The command id handed to the runtime for this attempt.
 *
 * Stable per (submission, attempt) so a redelivered dispatch is deduplicated by
 * the runtime rather than starting a second turn.
 */
export function workCommandId(submissionId: string, attemptId: string): string {
  return `${submissionId}:${attemptId}`
}
