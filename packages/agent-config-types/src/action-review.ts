// Unified Action Review contract.
//
// One protocol for every point where Cognia decides whether an action may run:
// chat tool approvals, Agent Team plan and capability gates, workflow step
// gates, connector HITL, and thread-handoff adjudication. Before this contract
// each of those had its own waiter, its own decision shape, and — for tool
// approvals — no durable record at all beyond a localStorage journal capped at
// 100 entries that marked everything interrupted on reboot.
//
// The three types here are the wire format between a PRODUCER (whoever wants to
// act), the POLICY ENGINE, and the RECEIPT LOG (`lib/db/action-review-receipts.ts`).
// The engine does not exist yet: each producer still resolves its own verdict.
// ADR-0239 decides it (`planActionReview` in `lib/policy/action-review/policy.ts`),
// starting with outbound actions. They deliberately restate —
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
  /** Squad plan approval (`lib/ai/agent/team/gates/squad-review-gate.ts`, kind `plan`). */
  | "agent-team-plan"
  /** Agent Team capability/risk gate (`lib/ai/agent/team/gates/squad-review-gate.ts`, kind `capability_audit`). */
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
  /**
   * A connector delivery planned at `enqueueGoverned` (ADR-0239): an automated
   * send that no tool-call review covered. Receipt-only, never a waiter: an
   * unauthorized unattended delivery becomes a draft a person approves.
   */
  | "connector-delivery"

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
  "connector-delivery",
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
  | "tool-call"
  | "plan"
  | "workflow-step"
  | "run-continue"
  | "handoff-commit"
  /** A connector delivery planned at the delivery gateway (ADR-0239). */
  | "connector-delivery"

/**
 * A party an outbound action delivers to (ADR-0239), as a receipt records it.
 *
 * The recipient itself is never stored. Conversation keys, platform user ids
 * and mail addresses are personal data, the receipt table is classed
 * metadata-only, and the scheduled tasks that hold the same targets are
 * encrypted for exactly that reason. Matching a fence or a grant only needs
 * equality, so a receipt keeps the fingerprint and the channel.
 */
export interface ActionReviewTarget {
  /** Delivery channel: a connector adapter id, `mail`, or `tool:<name>`. */
  channel: string
  /**
   * Lowercase hex SHA-256 of `outbound|<channel>|<normalized recipient>`,
   * computed by `lib/policy/action-review/outbound-targets.ts`. The message
   * body is never part of it, so rewording a refused send does not change it.
   */
  fingerprint: string
}

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
  /**
   * Who an outbound action delivers to (ADR-0239). Present only on outbound
   * reviews; one review can cover several targets (`im.broadcast`).
   */
  targets?: ActionReviewTarget[]
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
  /**
   * The session at the top of this action's run tree (ADR-0239): a subagent's,
   * teammate's or background child's review carries its root, so a person's
   * refusal fences the whole tree and not only the child that asked.
   */
  rootSessionId?: string
  /**
   * The requester's latest instruction in the root session when the review was
   * raised (ADR-0239), e.g. their newest message id. Instruction-scoped grants
   * and fence entries hold only while it is unchanged.
   */
  instructionEpoch?: string
}

/**
 * Non-authoritative model advice.
 *
 * A model may populate this and nothing else. It rides on the request into the
 * receipt, and `planActionReview` never reads it, so no code path exists by
 * which a model's opinion becomes an authorization.
 */
export interface ActionReviewRecommendation {
  suggests: "allow" | "deny"
  confidence?: "low" | "medium" | "high"
  rationale?: string
  /** Which judge produced it, e.g. "command-judge". */
  source: string
}

/** What `planActionReview` decided for a request (ADR-0239). */
export type ActionReviewPlanOutcome = "allow" | "ask" | "draft" | "park" | "deny"

export const ACTION_REVIEW_PLAN_OUTCOMES: readonly ActionReviewPlanOutcome[] = [
  "allow",
  "ask",
  "draft",
  "park",
  "deny",
]

/**
 * The engine's plan, kept on the receipt.
 *
 * `enforced: false` is shadow mode (ADR-0239 rollout): the plan was computed
 * and recorded while the action took its pre-existing path, so a person can
 * see what enforcement would change before turning it on.
 */
export interface ActionReviewPlan {
  outcome: ActionReviewPlanOutcome
  enforced: boolean
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
  /** Set by the policy engine on the outbound reviews it plans (ADR-0239). */
  plan?: ActionReviewPlan
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

/**
 * How far an authorization reaches (ADR-0239).
 *
 * - `once`: this single action.
 * - `instruction`: these targets until the root session's instruction epoch
 *   advances.
 * - `policy`: a recipient list a person configured on a Bot installation or a
 *   connector instance. Only a person can write one.
 */
export type ActionReviewGrantScope = "once" | "instruction" | "policy"

export const ACTION_REVIEW_GRANT_SCOPES: readonly ActionReviewGrantScope[] = [
  "once",
  "instruction",
  "policy",
]

export interface ActionReviewGrant {
  scope: ActionReviewGrantScope
  /** For `policy`: which configured list authorized it, e.g. `bot:<installationId>`. */
  policyRef?: string
}

/** Who an entry of a configured recipient list is. */
export type OutboundRecipientKind = "conversation" | "person" | "mail"

export const OUTBOUND_RECIPIENT_KINDS: readonly OutboundRecipientKind[] = [
  "conversation",
  "person",
  "mail",
]

/**
 * A recipient a person may configure (ADR-0239), in the engine's own
 * normalized form: `channel` is the connector adapter id (`mail` for mail) and
 * `recipient` is the kind-prefixed id (`conv:<platform>:<adapterId>:<chat>`,
 * `person:<adapterId>:<member>`, `mail:<address>`). The fingerprint the engine
 * matches is derived from these two, so the list stores the recipient itself:
 * a person has to be able to read back whom they allowed.
 */
export interface OutboundRecipient {
  kind: OutboundRecipientKind
  channel: string
  recipient: string
}

/**
 * One entry of a `policy` grant: a recipient a Bot installation or a connector
 * instance may deliver to with nobody watching. Only a person writes one, from
 * the settings UI; no plugin, agent or tool path can.
 */
export interface OutboundRecipientGrant {
  recipient: OutboundRecipient
  addedAt: number
  addedBy: "local-user"
}

const MAX_OUTBOUND_RECIPIENT_GRANTS = 500

function recipientErrors(value: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`)
    return
  }
  const kind = value.kind
  if (!OUTBOUND_RECIPIENT_KINDS.includes(kind as OutboundRecipientKind)) {
    errors.push(`${path}.kind must be one of ${OUTBOUND_RECIPIENT_KINDS.join(", ")}`)
    return
  }
  if (typeof value.channel !== "string" || !value.channel.trim()) {
    errors.push(`${path}.channel must be a non-empty string`)
  } else if ((kind === "mail") !== (value.channel === "mail")) {
    errors.push(`${path}.channel must be "mail" exactly for a mail recipient`)
  }
  const prefix = kind === "conversation" ? "conv:" : kind === "person" ? "person:" : "mail:"
  if (
    typeof value.recipient !== "string" ||
    !value.recipient.startsWith(prefix) ||
    value.recipient.length === prefix.length
  ) {
    errors.push(`${path}.recipient must start with "${prefix}" and name a recipient`)
  }
  for (const key of Object.keys(value)) {
    if (key !== "kind" && key !== "channel" && key !== "recipient") {
      errors.push(`${path}.${key} is not a recipient field`)
    }
  }
}

/** Validate a configured recipient list. Returns the errors; empty means valid. */
export function validateOutboundRecipientGrants(value: unknown): string[] {
  const errors: string[] = []
  if (!Array.isArray(value)) return ["outboundRecipients must be an array"]
  if (value.length > MAX_OUTBOUND_RECIPIENT_GRANTS) {
    errors.push(`outboundRecipients holds at most ${MAX_OUTBOUND_RECIPIENT_GRANTS} entries`)
  }
  value.forEach((entry, i) => {
    const path = `outboundRecipients[${i}]`
    if (!isPlainObject(entry)) {
      errors.push(`${path} must be an object`)
      return
    }
    recipientErrors(entry.recipient, `${path}.recipient`, errors)
    if (!isFiniteNumber(entry.addedAt)) {
      errors.push(`${path}.addedAt must be a finite number`)
    }
    if (entry.addedBy !== "local-user") errors.push(`${path}.addedBy must be "local-user"`)
    for (const key of Object.keys(entry)) {
      if (key !== "recipient" && key !== "addedAt" && key !== "addedBy") {
        errors.push(`${path}.${key} is not a grant field`)
      }
    }
  })
  return errors
}

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
  /** The authorization an outbound allow rests on (ADR-0239). Absent on refusals. */
  grant?: ActionReviewGrant
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
  for (const field of ["rootSessionId", "instructionEpoch"] as const) {
    if (origin[field] !== undefined && !isNonEmptyString(origin[field])) {
      errors.push(`origin.${field} must be a non-empty string`)
    }
  }
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
    "connector-delivery",
  ]
  if (!memberOf(subject.kind, kinds)) {
    errors.push("subject.kind must be a known ActionReviewSubjectKind")
  }
  if (!isNonEmptyString(subject.ref)) errors.push("subject.ref is required")
  if (subject.input !== undefined && !isPlainObject(subject.input)) {
    errors.push("subject.input must be an object")
  }
  if (subject.targets !== undefined) validateTargets(subject.targets, errors)
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

function validateTargets(targets: unknown, errors: string[]): void {
  if (!Array.isArray(targets)) {
    errors.push("subject.targets must be an array")
    return
  }
  for (const [i, target] of targets.entries()) {
    if (!isPlainObject(target)) {
      errors.push(`subject.targets[${i}] must be an object`)
      continue
    }
    if (!isNonEmptyString(target.channel)) {
      errors.push(`subject.targets[${i}].channel is required`)
    }
    // A raw recipient in this slot would put personal data in a metadata-only
    // table; only a fingerprint passes.
    if (typeof target.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(target.fingerprint)) {
      errors.push(`subject.targets[${i}].fingerprint must be a lowercase hex SHA-256`)
    }
    const extra = Object.keys(target).filter((key) => key !== "channel" && key !== "fingerprint")
    if (extra.length > 0) {
      errors.push(`subject.targets[${i}] carries unknown fields: ${extra.join(", ")}`)
    }
  }
}

function validatePlan(plan: unknown, errors: string[]): void {
  if (plan === undefined) return
  if (!isPlainObject(plan)) {
    errors.push("plan must be an object")
    return
  }
  if (!memberOf(plan.outcome, ACTION_REVIEW_PLAN_OUTCOMES)) {
    errors.push("plan.outcome must be a known ActionReviewPlanOutcome")
  }
  if (typeof plan.enforced !== "boolean") errors.push("plan.enforced must be a boolean")
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
  validatePlan(req.plan, errors)

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
  if (dec.grant !== undefined) {
    if (!isPlainObject(dec.grant)) {
      errors.push("grant must be an object")
    } else {
      if (!memberOf(dec.grant.scope, ACTION_REVIEW_GRANT_SCOPES)) {
        errors.push("grant.scope must be once, instruction, or policy")
      }
      if (dec.grant.policyRef !== undefined && !isNonEmptyString(dec.grant.policyRef)) {
        errors.push("grant.policyRef must be a non-empty string")
      }
      // A grant is what an allow rests on; a refusal carrying one is a
      // producer bug that would read as an authorization in the audit log.
      if (!permitsOutcome(dec.outcome)) errors.push("grant requires a permitting outcome")
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
