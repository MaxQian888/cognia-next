// Unified Action Review contract (ADR-0102).
//
// One protocol for every point where Cognia decides whether an action may run:
// chat tool approvals, Agent Team plan and capability gates, workflow step
// gates, connector HITL, and thread-handoff adjudication. Before this contract
// each of those had its own waiter, its own decision shape, and — for tool
// approvals — no durable record at all beyond a localStorage journal capped at
// 100 entries that marked everything interrupted on reboot.
//
// The three types here are the wire format between a PRODUCER (whoever wants to
// act), the POLICY ENGINE (`lib/policy/action-review/policy.ts`), and the
// RECEIPT LOG (`lib/db/action-review-receipts.ts`). They deliberately restate —
// rather than import — the verdict, tier, and surface vocabularies from
// `lib/claude/permissions/ruleset.ts` and `lib/policy/risk/*`, because this
// package must stay free of `@/` imports so the CLI can consume it. The
// restatements are pinned by `lib/policy/action-review/contract-parity.test.ts`,
// which fails if the two ever drift.
//
// Zero-dependency hand-written guards, matching the rest of this package.

import { isNonEmptyString, refViolation } from "./ref-safety"

export const ACTION_REVIEW_CONTRACT_VERSION = 1 as const

/**
 * Which decision point raised this review.
 *
 * Wire format — persisted on every receipt and indexed. Append-only; never
 * rename a member, because renaming one orphans every receipt already written.
 */
export type ActionReviewChannel =
  /** Sidecar `canUseTool` → the chat approval dialog. The largest producer. */
  | "chat-tool"
  /** Squad plan approval (`lib/runtime/approval-bus.ts`, scope `agent-team`). */
  | "agent-team-plan"
  /** Agent Team capability/risk gate (`lib/ai/agent/agent-team-runtime.ts`). */
  | "agent-team-gate"
  /** Workflow `action.approval.request` node. */
  | "workflow-step"
  /** Connector HITL tool approval (`lib/connectors/hitl/tool-approval.ts`). */
  | "connector-tool"
  /** A2UI workflow approve/cancel callback — receipt-only, never a waiter. */
  | "connector-workflow"
  /** GitHub publish paths (`scope: "github"`). */
  | "github-delivery"
  /** Stranded thread-handoff ticket adjudication (ADR-0103). */
  | "thread-handoff"
  /** A Bot handler's `step.waitForApproval`. */
  | "bot-step"
  /** Squad token budget extension (ADR-0169). */
  | "agent-team-budget"
  /** Squad deadlock resolution. */
  | "agent-team-deadlock"
  /** Squad teammate repair (rejoin or skip a disqualified member). */
  | "agent-team-teammate-repair"
  /** Squad mid-run re-plan checkpoint. */
  | "agent-team-replan"
  /** Squad recovery from an uncertain child checkpoint. */
  | "agent-team-recovery"
  /** Anything reaching the generic approval bus without a richer channel. */
  | "generic"

export const ACTION_REVIEW_CHANNELS: readonly ActionReviewChannel[] = [
  "chat-tool",
  "agent-team-plan",
  "agent-team-gate",
  "workflow-step",
  "connector-tool",
  "connector-workflow",
  "github-delivery",
  "thread-handoff",
  "bot-step",
  "agent-team-budget",
  "agent-team-deadlock",
  "agent-team-teammate-repair",
  "agent-team-replan",
  "agent-team-recovery",
  "generic",
]

/** RESTATEMENT of `PermissionVerdict` (lib/claude/permissions/ruleset.ts). */
export type ActionReviewVerdict = "allow" | "ask" | "deny"

export const ACTION_REVIEW_VERDICTS: readonly ActionReviewVerdict[] = ["allow", "ask", "deny"]

/** RESTATEMENT of `RiskTier` (lib/policy/risk/classify-risk.ts). */
export type ActionReviewTier = "low" | "medium" | "high"

export const ACTION_REVIEW_TIERS: readonly ActionReviewTier[] = ["low", "medium", "high"]

/** RESTATEMENT of `RiskSurfaceId` (lib/policy/risk/risk-surfaces.ts). */
export type ActionReviewSurfaceId =
  | "external-send"
  | "computer-use"
  | "native-command"
  | "data-destructive"
  | "credential-auth"
  | "file-write-broad"

export const ACTION_REVIEW_SURFACE_IDS: readonly ActionReviewSurfaceId[] = [
  "external-send",
  "computer-use",
  "native-command",
  "data-destructive",
  "credential-auth",
  "file-write-broad",
]

/**
 * A tripped risk surface.
 *
 * Structurally identical to `RiskSurfaceHit`, and deliberately carries NO
 * severity field. `classifyRisk` downgrades `native-command` under a sandbox,
 * and that downgrade is observable only through the resulting {@link
 * ActionReviewRequest.tier}. Restating a static per-surface severity here would
 * let a receipt claim "high" for a surface the classifier had already
 * downgraded — a lie in the audit log. Read `tier` for severity.
 */
export interface ActionReviewSurfaceHit {
  id: ActionReviewSurfaceId
  /** What tripped the rule — a tool id, a capability id, or a matched term. */
  evidence: string
}

/** What kind of thing is being reviewed. */
export type ActionReviewSubjectKind =
  "tool-call" | "plan" | "workflow-step" | "run-continue" | "handoff-commit"

export interface ActionReviewSubject {
  kind: ActionReviewSubjectKind
  /** Stable identity of the thing: tool name, node kind, teamId, ticketId. */
  ref: string
  /** Producer-supplied display title (already localized, or absent). */
  title?: string
  /** JSON-safe, PII-redacted argument snapshot. Never raw secrets. */
  input?: Record<string, unknown>
  /** Shell command line when the subject is a command (feeds command-safety). */
  command?: string
  /** Filesystem target when the subject touches a path (feeds the ruleset glob). */
  path?: string
}

export interface ActionReviewOrigin {
  channel: ActionReviewChannel
  /** Scope + id so a review maps 1:1 onto the legacy waiter-bus key. */
  scope: string
  id: string
  sessionId?: string
  /** The parent chat/team session the UI surfaces this under. */
  bucketSessionId?: string
  runId?: string
  teamId?: string
  workflowId?: string
  projectId?: string
  /** Host that will EXECUTE the action: "local" or a RemoteHost id (ADR-0082). */
  hostRef?: string
  /** True when no human can possibly answer (scheduled / headless / IM auto). */
  headless?: boolean
}

/**
 * Non-authoritative model advice.
 *
 * A model may populate this and nothing else. `planActionReview` copies it onto
 * the request and never reads it, so no code path exists by which a model's
 * opinion becomes an authorization.
 */
export interface ActionReviewRecommendation {
  suggests: "allow" | "deny"
  confidence?: "low" | "medium" | "high"
  rationale?: string
  /** Which judge produced it, e.g. "command-judge". */
  source: string
}

export interface ActionReviewRequest {
  contractVersion: typeof ACTION_REVIEW_CONTRACT_VERSION
  requestId: string
  origin: ActionReviewOrigin
  subject: ActionReviewSubject
  /** Deterministic ruleset verdict resolved by the producer. */
  verdict: ActionReviewVerdict
  /** True when `verdict` came from an EXPLICIT rule (ResolvedPermission.layer > 0). */
  verdictExplicit: boolean
  tier: ActionReviewTier
  surfaces: ActionReviewSurfaceHit[]
  recommendation?: ActionReviewRecommendation
  requestedAt: number
  /** Absolute ms after which the review auto-denies. */
  expiresAt?: number
}

export type ActionReviewOutcome = "allow" | "allow_always" | "deny" | "expired" | "interrupted"

export const ACTION_REVIEW_OUTCOMES: readonly ActionReviewOutcome[] = [
  "allow",
  "allow_always",
  "deny",
  "expired",
  "interrupted",
]

/**
 * WHO authorized.
 *
 * There is deliberately no `"model"` member. A model may populate
 * {@link ActionReviewRequest.recommendation}, and nothing else. The absence is
 * the enforcement: {@link validateActionReviewDecision} rejects any unknown
 * authority string at the wire boundary, so a producer cannot invent one.
 */
export type ActionReviewAuthority =
  /** An explicit click/tap by a person. */
  | "human"
  /** An explicit user/character/plugin ruleset rule (layer > 0). */
  | "policy-rule"
  /** Deterministic low-risk auto-allow from the baked-in defaults. */
  | "policy-default"
  /** Catastrophic auto-deny (command-safety, or an explicit deny rule). */
  | "policy-deny"
  /** TTL backstop. Always a deny. */
  | "timeout"
  /** Waiter died, session closed, run aborted, thread frozen. */
  | "system"

export const ACTION_REVIEW_AUTHORITIES: readonly ActionReviewAuthority[] = [
  "human",
  "policy-rule",
  "policy-default",
  "policy-deny",
  "timeout",
  "system",
]

export type ActionReviewActorKind = "local-user" | "device" | "connector-user"

export interface ActionReviewDecision {
  contractVersion: typeof ACTION_REVIEW_CONTRACT_VERSION
  requestId: string
  outcome: ActionReviewOutcome
  authority: ActionReviewAuthority
  reason?: string
  /** Operator-edited tool input, when the dialog allowed an edit. */
  updatedInput?: Record<string, unknown>
  /** Scoped allow rule derived from an `allow_always` (deriveAllowRuleFromApproval). */
  derivedRule?: { tool: string; pattern: string }
  actor?: { kind: ActionReviewActorKind; id?: string; label?: string }
  decidedAt: number
}

export type ActionReviewEffectStatus = "executed" | "blocked" | "failed" | "not-attempted"

export const ACTION_REVIEW_EFFECT_STATUSES: readonly ActionReviewEffectStatus[] = [
  "executed",
  "blocked",
  "failed",
  "not-attempted",
]

export interface ActionReviewEffect {
  status: ActionReviewEffectStatus
  /** Truncated digest of the result — never full tool output. */
  detail?: string
  errorText?: string
  durationMs?: number
  completedAt?: number
}

export interface ActionReviewReceipt {
  contractVersion: typeof ACTION_REVIEW_CONTRACT_VERSION
  /** === `request.requestId`. The receipt IS the durable identity of one review. */
  id: string
  request: ActionReviewRequest
  decision: ActionReviewDecision
  effect?: ActionReviewEffect
  /** Retention watermark = `decision.decidedAt + retentionDays`. Indexed. */
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

function validateOrigin(origin: unknown, errors: string[]): void {
  if (!isPlainObject(origin)) {
    errors.push("origin is required")
    return
  }
  if (!memberOf(origin.channel, ACTION_REVIEW_CHANNELS)) {
    errors.push("origin.channel must be a known ActionReviewChannel")
  }
  if (!isNonEmptyString(origin.scope)) errors.push("origin.scope is required")
  if (!isNonEmptyString(origin.id)) errors.push("origin.id is required")
  // `hostRef` crosses a host boundary, so it obeys the same ref rules as a
  // handoff envelope: an id, never a URL, never a credential.
  if (origin.hostRef !== undefined) {
    if (!isNonEmptyString(origin.hostRef)) {
      errors.push("origin.hostRef must be a non-empty string")
    } else {
      const violation = refViolation(origin.hostRef)
      if (violation) errors.push(`origin.hostRef: ${violation}`)
    }
  }
}

function validateSubject(subject: unknown, errors: string[]): void {
  if (!isPlainObject(subject)) {
    errors.push("subject is required")
    return
  }
  const kinds: readonly ActionReviewSubjectKind[] = [
    "tool-call",
    "plan",
    "workflow-step",
    "run-continue",
    "handoff-commit",
  ]
  if (!memberOf(subject.kind, kinds)) {
    errors.push("subject.kind must be a known ActionReviewSubjectKind")
  }
  if (!isNonEmptyString(subject.ref)) errors.push("subject.ref is required")
  if (subject.input !== undefined && !isPlainObject(subject.input)) {
    errors.push("subject.input must be an object")
  }
}

function validateSurfaces(surfaces: unknown, errors: string[]): void {
  if (!Array.isArray(surfaces)) {
    errors.push("surfaces must be an array")
    return
  }
  for (const [i, hit] of surfaces.entries()) {
    if (!isPlainObject(hit)) {
      errors.push(`surfaces[${i}] must be an object`)
      continue
    }
    if (!memberOf(hit.id, ACTION_REVIEW_SURFACE_IDS)) {
      errors.push(`surfaces[${i}].id must be a known ActionReviewSurfaceId`)
    }
    if (!isNonEmptyString(hit.evidence)) errors.push(`surfaces[${i}].evidence is required`)
  }
}

function validateRecommendation(rec: unknown, errors: string[]): void {
  if (rec === undefined) return
  if (!isPlainObject(rec)) {
    errors.push("recommendation must be an object")
    return
  }
  if (rec.suggests !== "allow" && rec.suggests !== "deny") {
    errors.push('recommendation.suggests must be "allow" or "deny"')
  }
  if (!isNonEmptyString(rec.source)) errors.push("recommendation.source is required")
  if (
    rec.confidence !== undefined &&
    !memberOf(rec.confidence, ["low", "medium", "high"] as const)
  ) {
    errors.push("recommendation.confidence must be low, medium, or high")
  }
}

/** Validate a request. Returns a list of violations (empty = valid). */
export function validateActionReviewRequest(value: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(value)) return ["request must be an object"]
  const req = value as Partial<ActionReviewRequest>

  if (req.contractVersion !== ACTION_REVIEW_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${ACTION_REVIEW_CONTRACT_VERSION}`)
  }
  if (!isNonEmptyString(req.requestId)) errors.push("requestId is required")

  validateOrigin(req.origin, errors)
  validateSubject(req.subject, errors)

  if (!memberOf(req.verdict, ACTION_REVIEW_VERDICTS)) {
    errors.push("verdict must be allow, ask, or deny")
  }
  if (typeof req.verdictExplicit !== "boolean") {
    errors.push("verdictExplicit must be a boolean")
  }
  if (!memberOf(req.tier, ACTION_REVIEW_TIERS)) {
    errors.push("tier must be low, medium, or high")
  }

  validateSurfaces(req.surfaces, errors)
  validateRecommendation(req.recommendation, errors)

  if (!isFiniteNumber(req.requestedAt)) errors.push("requestedAt must be a finite number")
  if (req.expiresAt !== undefined && !isFiniteNumber(req.expiresAt)) {
    errors.push("expiresAt must be a finite number")
  }

  return errors
}

export function isActionReviewRequest(value: unknown): value is ActionReviewRequest {
  return validateActionReviewRequest(value).length === 0
}

/** Validate a decision. Returns a list of violations (empty = valid). */
export function validateActionReviewDecision(value: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(value)) return ["decision must be an object"]
  const dec = value as Partial<ActionReviewDecision>

  if (dec.contractVersion !== ACTION_REVIEW_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${ACTION_REVIEW_CONTRACT_VERSION}`)
  }
  if (!isNonEmptyString(dec.requestId)) errors.push("requestId is required")
  if (!memberOf(dec.outcome, ACTION_REVIEW_OUTCOMES)) {
    errors.push("outcome must be a known ActionReviewOutcome")
  }
  // The gate that keeps a model from authorizing: an authority outside this
  // closed set — "model", "auto", anything a producer invents — is rejected
  // here rather than silently persisted as if a human had clicked.
  if (!memberOf(dec.authority, ACTION_REVIEW_AUTHORITIES)) {
    errors.push("authority must be a known ActionReviewAuthority")
  }
  // A timeout is a backstop, never a grant.
  if (dec.authority === "timeout" && permitsOutcome(dec.outcome)) {
    errors.push('authority "timeout" cannot permit execution')
  }
  if (dec.updatedInput !== undefined && !isPlainObject(dec.updatedInput)) {
    errors.push("updatedInput must be an object")
  }
  if (dec.derivedRule !== undefined) {
    if (!isPlainObject(dec.derivedRule)) {
      errors.push("derivedRule must be an object")
    } else {
      if (!isNonEmptyString(dec.derivedRule.tool)) errors.push("derivedRule.tool is required")
      if (!isNonEmptyString(dec.derivedRule.pattern)) errors.push("derivedRule.pattern is required")
    }
  }
  if (dec.actor !== undefined) {
    if (!isPlainObject(dec.actor)) {
      errors.push("actor must be an object")
    } else if (!memberOf(dec.actor.kind, ["local-user", "device", "connector-user"] as const)) {
      errors.push("actor.kind must be a known ActionReviewActorKind")
    }
  }
  if (!isFiniteNumber(dec.decidedAt)) errors.push("decidedAt must be a finite number")

  return errors
}

export function isActionReviewDecision(value: unknown): value is ActionReviewDecision {
  return validateActionReviewDecision(value).length === 0
}

function validateEffect(effect: unknown, errors: string[]): void {
  if (effect === undefined) return
  if (!isPlainObject(effect)) {
    errors.push("effect must be an object")
    return
  }
  if (!memberOf(effect.status, ACTION_REVIEW_EFFECT_STATUSES)) {
    errors.push("effect.status must be a known ActionReviewEffectStatus")
  }
  if (effect.durationMs !== undefined && !isFiniteNumber(effect.durationMs)) {
    errors.push("effect.durationMs must be a finite number")
  }
  if (effect.completedAt !== undefined && !isFiniteNumber(effect.completedAt)) {
    errors.push("effect.completedAt must be a finite number")
  }
}

/** Validate a receipt. Returns a list of violations (empty = valid). */
export function validateActionReviewReceipt(value: unknown): string[] {
  const errors: string[] = []
  if (!isPlainObject(value)) return ["receipt must be an object"]
  const receipt = value as Partial<ActionReviewReceipt>

  if (receipt.contractVersion !== ACTION_REVIEW_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${ACTION_REVIEW_CONTRACT_VERSION}`)
  }
  if (!isNonEmptyString(receipt.id)) errors.push("id is required")

  for (const violation of validateActionReviewRequest(receipt.request)) {
    errors.push(`request: ${violation}`)
  }
  for (const violation of validateActionReviewDecision(receipt.decision)) {
    errors.push(`decision: ${violation}`)
  }

  // The three ids are one identity. A receipt whose parts disagree cannot be
  // correlated back to the review it claims to record.
  const request = receipt.request as ActionReviewRequest | undefined
  const decision = receipt.decision as ActionReviewDecision | undefined
  if (isNonEmptyString(receipt.id) && request?.requestId && receipt.id !== request.requestId) {
    errors.push("id must equal request.requestId")
  }
  if (request?.requestId && decision?.requestId && request.requestId !== decision.requestId) {
    errors.push("decision.requestId must equal request.requestId")
  }

  validateEffect(receipt.effect, errors)

  if (!isFiniteNumber(receipt.expiresAt)) errors.push("expiresAt must be a finite number")

  return errors
}

export function isActionReviewReceipt(value: unknown): value is ActionReviewReceipt {
  return validateActionReviewReceipt(value).length === 0
}

function permitsOutcome(outcome: unknown): boolean {
  return outcome === "allow" || outcome === "allow_always"
}

/**
 * True when the outcome permits execution.
 *
 * The single place callers ask "may I run this?". `deny`, `expired`, and
 * `interrupted` are all refusals — an expired review is not a tacit yes.
 */
export function permitsExecution(decision: ActionReviewDecision): boolean {
  return permitsOutcome(decision.outcome)
}
