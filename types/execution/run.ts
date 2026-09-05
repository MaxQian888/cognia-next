/** Stable execution semantics shared by agent turns, workflows, and IM presenters. */

import type { ConversationDeliveryTarget } from "@/types/connectors/event"

export type ExecutionRunKind =
  | "agent-turn"
  | "workflow"
  | "plan"
  | "goal"
  | "team"
  | "scheduled"
  /**
   * A unit of asynchronous work a person handed over: it reports back, can be
   * steered, stopped, and handed to a human, and it OWNS the runs that carry
   * it out (they point at it through `parentRunId`).
   *
   * Deliberately not a synonym for any of the kinds above. Those name the
   * ENGINE that executes; this one names the COMMITMENT, which outlives any
   * single engine attempt — a delegation whose agent turn fails is still an
   * open delegation, and the retry is a new child, not a resurrected run.
   */
  | "delegation"
  /**
   * Background work with an owner: a subagent dispatch, a plugin agent, or a
   * native supervisor job. Stoppable and inspectable, but never steerable or
   * pausable — there is no live input lane to steer and no coordinator to
   * pause, which `allowedActions` already reflects without a special case.
   *
   * Distinct from `agent-turn`, which is a turn IN a conversation the user is
   * watching; a job reports back when it is done.
   */
  | "job"
  /**
   * An authorized security scan of a named target.
   *
   * Its own kind rather than a `job` because the thing that makes it different
   * is not how it executes but what a settled one MEANS: a scan that ends
   * without a readable report is inconclusive, not successful, and every
   * surface that reads run status has to be able to tell those apart. It also
   * carries an authorization record — a pentest is only legitimate against a
   * system the operator was cleared to test — which no other kind has.
   *
   * Stoppable, never steerable or pausable: the scanner is an external process
   * with no live input lane, which `allowedActions` already yields without a
   * special case.
   */
  | "security-scan"
  /**
   * One installed Bot reacting to one event.
   *
   * Its own kind rather than a `job` because of what the delivery behind it
   * means: a Bot run is the visible half of a queue entry that was leased,
   * may be retried, and may be dead-lettered, and every surface that reads run
   * status has to be able to answer "will this be tried again" without
   * consulting a second system. It also parks on human decisions the way a
   * workflow does, which a job never has.
   *
   * Stoppable and retryable, never steerable: a Bot run has no live input lane
   * a person is typing into, which `allowedActions` yields without a special
   * case.
   */
  | "bot"

export type ExecutionRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "recovery_required"
  | "completed"
  | "failed"
  | "cancelled"

export type RunEventVisibility = "summary" | "detail" | "private"

export type RunEventType =
  | "run.started"
  | "run.waiting"
  | "run.paused"
  | "run.resumed"
  | "run.recovery_required"
  | "run.degraded"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "plan.created"
  | "plan.revised"
  | "step.added"
  | "step.started"
  | "step.progress"
  | "step.completed"
  | "step.failed"
  | "step.skipped"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "interrupt.requested"
  | "interrupt.resolved"
  | "interrupt.expired"
  | "artifact.created"
  | "resource.changed"
  | "resource.summary"
  | "milestone.created"
  | "control.accepted"
  | "control.rejected"
  | "projection.degraded"

export type RunStepStatus =
  "pending" | "in_progress" | "completed" | "failed" | "skipped" | "blocked"

export interface RunStepSnapshot {
  id: string
  title: string
  status: RunStepStatus
  summary?: string
  detail?: string
  startedAt?: number
  completedAt?: number
}

export interface RunProgressSnapshot {
  completed: number
  total: number
  ratio?: number
  trustworthy: boolean
}

export type RunControlAction =
  | "stop"
  | "pause"
  | "resume"
  | "approve"
  | "deny"
  | "retry"
  | "open_details"
  /**
   * Redirect work that is already running, without stopping it.
   *
   * The message itself travels in `RunControlCommand.steerMessage` and is
   * NEVER journalled: `control.accepted` carries only a receipt id. The run
   * journal is a projection surface read by IM cards, so free user text in it
   * would be a redaction hole in every platform at once.
   */
  | "steer"

/**
 * What an artifact IS, when the producer knows.
 *
 * Optional on {@link RunArtifactSnapshot} because the field postdates the
 * shape: an artifact without a kind is the generic one the reducer has always
 * projected, not an unknown-and-therefore-suspect one.
 */
export type RunArtifactKind = "generic" | "verification"

export type RunVerificationConclusion = "passed" | "failed" | "inconclusive"

/**
 * The COUNTS of a verification run, and nothing else.
 *
 * Deliberately holds no output, no failing-test names, and no command line.
 * Test output routinely contains file paths, environment values, and assertion
 * payloads; the run journal is projected into IM cards and remote surfaces, so
 * copying it there would be a redaction hole. The full output stays with the
 * transcript owner and is reachable through `RunArtifactSnapshot.detailsRef`.
 *
 * `inconclusive` is a first-class outcome, not an error case. Output that could
 * not be parsed must never be reported as `0 failed` — a silent green is the
 * one failure mode this whole projection exists to avoid.
 */
export interface RunVerificationSummary {
  conclusion: RunVerificationConclusion
  passed: number
  failed: number
  skipped: number
  total: number
  durationMs?: number
}

export interface RunArtifactSnapshot {
  id: string
  title: string
  url?: string
  mimeType?: string
  kind?: RunArtifactKind
  /**
   * Opaque handle to the full detail, resolved by whoever owns it (for a
   * verification run, the tool call in the transcript). Never a payload and
   * never a path — an id the owner can look up, or nothing.
   */
  detailsRef?: string
  /** Present exactly when `kind === "verification"`. */
  verification?: RunVerificationSummary
}

export type RunActivityKind = "lifecycle" | "tool" | "step" | "artifact" | "approval"

export type RunActivityCategory =
  | "search"
  | "read"
  | "write"
  | "command"
  | "integration"
  | "skill"
  | "artifact"
  | "approval"
  | "status"

export type RunActivityStatus =
  "pending" | "running" | "completed" | "failed" | "skipped" | "blocked"

export interface RunActivityTarget {
  kind: "workspace_path" | "resource"
  label: string
  /** Required provenance marker for caller-declared non-sensitive resource titles. */
  safe?: true
}

export interface RunActivitySnapshot {
  id: string
  kind: RunActivityKind
  category: RunActivityCategory
  status: RunActivityStatus
  label: string
  target?: RunActivityTarget
  startedAt: number
  endedAt?: number
}

export interface RunProjectionSnapshot {
  runId: string
  kind: ExecutionRunKind
  title: string
  status: ExecutionRunStatus
  revision: number
  startedAt: number
  updatedAt: number
  endedAt?: number
  planVersion?: number
  progress: RunProgressSnapshot
  activeSteps: RunStepSnapshot[]
  recentSteps: RunStepSnapshot[]
  pendingSteps: RunStepSnapshot[]
  pendingStepCount: number
  /** Safe, platform-neutral execution timeline. Absent on legacy snapshots. */
  activities?: RunActivitySnapshot[]
  /** Total safe activities before applying the rolling presentation window. */
  activityCount?: number
  /** Number of safe activities omitted from the rolling presentation window. */
  omittedActivityCount?: number
  /** Durable inbound turns waiting behind this run in the same conversation. */
  connectorQueueDepth?: number
  elapsedMs: number
  detailsUrl?: string
  summary?: string
  error?: string
  waitingReason?: string
  pendingInterrupt?: {
    id: string
    title: string
    expiresAt?: number
    /** The interrupt type, so a card can render the matching decision form. */
    type?: string
  }
  /**
   * The Squad a `team` run belongs to, read from its opening event. Lets a
   * team-scoped list (the `/squads` Runs tab) filter journal rows without a
   * second query per row.
   */
  teamId?: string
  artifacts: RunArtifactSnapshot[]
  allowedActions: RunControlAction[]
  locale?: string
}

export interface ExecutionRunInitiator {
  platformIdentityId?: string
  remoteUserId?: string
  displayName?: string
  /**
   * Authoritative identity stamp (Lark unified identity, plan 2026-07-24
   * P1.4): the resolved FeishuPrincipalRow id and its Cognia account. Absent
   * on legacy runs and whenever the principal registry flag is off.
   */
  principalId?: string
  accountId?: string
}

/**
 * What a `retry` control left behind on the run it replaced.
 *
 * Stamped on the ROW, never in the journal. A settled run's history is final —
 * `appendInsideTransaction` refuses every event past a terminal status, and
 * that guarantee is worth keeping. But the row still has to remember, or a
 * redelivered press forks a second replacement and nothing can point at the run
 * that took the work over.
 */
export interface ExecutionRunRetryStamp {
  /** The control command that minted the replacement. */
  idempotencyKey: string
  /** The replacement run. It links back through its own `parentRunId`. */
  runId: string
  at: number
}

export interface ExecutionRun {
  id: string
  /** Previous immutable journal run when this run continues a recovered attempt. */
  parentRunId?: string
  kind: ExecutionRunKind
  sourceId: string
  sessionId?: string
  projectId?: string
  title: string
  status: ExecutionRunStatus
  initiator?: ExecutionRunInitiator
  currentRevision: number
  latestSnapshot?: RunProjectionSnapshot
  startedAt: number
  updatedAt: number
  endedAt?: number
  /** Set once a `retry` control minted a replacement for this settled run. */
  retry?: ExecutionRunRetryStamp
}

export interface RunEvent {
  id: string
  runId: string
  seq: number
  ts: number
  type: RunEventType
  visibility: RunEventVisibility
  /** Payloads are semantic summaries only; raw reasoning and tool arguments are forbidden. */
  payload: Record<string, unknown>
  projectId?: string
  sourceEventId?: string
}

/**
 * What kind of decision a Squad review asks for (ADR-0169).
 *
 * One vocabulary for every Squad gate: the plan, the pre-run capability audit,
 * a budget extension, a deadlock resolution, a teammate repair, a re-plan and
 * an uncertain recovery. Each maps 1:1 onto an `ExecutionRunInterrupt["type"]`
 * (`squadReviewInterruptType`) and onto exactly one shape of
 * {@link SquadReviewDecision}, which the control gate validates before any
 * handler sees it.
 */
export type SquadReviewKind =
  | "plan"
  | "capability_audit"
  | "budget_extension"
  | "deadlock"
  | "teammate_repair"
  | "replan"
  | "team_recovery"

export type TeamRecoveryChoice = "retry_same_host" | "retry_host" | "restart_run" | "terminate"

/**
 * The typed payload of a Squad review decision. Travels on
 * {@link RunControlCommand.reviewDecision} with `action: "approve" | "deny"`.
 *
 * Free text (`feedback`) is the ONE unstructured member. It passes through
 * PII redaction before it reaches the engine and is never copied into a run
 * event: journals carry reason codes, actor references and receipt ids only.
 */
export type SquadReviewDecision =
  | { kind: "plan"; feedback?: string }
  | { kind: "capability_audit" }
  | { kind: "budget_extension"; extraTokens: number }
  | { kind: "deadlock"; teammateIds?: string[]; resetAll?: boolean }
  | { kind: "teammate_repair"; action: "rejoin" | "skip" }
  | { kind: "replan"; edited?: Record<string, unknown> }
  | { kind: "team_recovery"; choice: TeamRecoveryChoice; hostRef?: string }

export interface RunControlCommand {
  runId: string
  action: RunControlAction
  idempotencyKey: string
  expectedRevision: number
  actor: ExecutionRunInitiator
  interruptId?: string
  /**
   * Typed decision for a Squad review interrupt. Required when the interrupt
   * is a Squad kind and the action is `approve` (a `deny` may omit it). Its
   * `kind` must match the interrupt, or the command is `invalid_command`.
   */
  reviewDecision?: SquadReviewDecision
  /**
   * Free text for `steer` (and the optional note on a handoff `resume`).
   *
   * Held on the command rather than in the journal on purpose — see
   * `RunControlAction["steer"]`. Handlers pass it to the engine's own steering
   * seam, which owns the PII gate for it.
   */
  steerMessage?: string
}

export interface RunPresentationCapabilities {
  topicIsolation?: boolean
  textStreaming?: boolean
  componentMutation?: boolean
  fullReplacement?: boolean
  messageEditing?: boolean
  appendFallback?: boolean
  interactiveControls: boolean
  followUpBubbles?: boolean
  /** @deprecated Use textStreaming. */
  nativeStreaming?: boolean
  /** @deprecated Use componentMutation. */
  partialUpdate?: boolean
  /** @deprecated Use messageEditing. */
  messageEdit?: boolean
}

export interface RunPresentationRef {
  platformMessageId?: string
  opaqueState?: Record<string, unknown>
}

export interface RunPresentationTarget {
  adapterId: string
  conversationKey: string
  /** Platform message that initiated the run; required by thread-native streams such as Slack. */
  sourceMessageId?: string
  deliveryTarget?: ConversationDeliveryTarget
  recipientUserId?: string
  recipientTeamId?: string
}

export interface RunPresentationMutationOptions {
  checkpoint?: (ref: RunPresentationRef) => Promise<void>
}

export interface RunPresentationDriver {
  readonly capabilities: RunPresentationCapabilities
  open(
    target: RunPresentationTarget,
    snapshot: RunProjectionSnapshot,
    options?: {
      previousRef?: RunPresentationRef
      checkpoint?: (ref: RunPresentationRef) => Promise<void>
    }
  ): Promise<RunPresentationRef>
  update(
    ref: RunPresentationRef,
    snapshot: RunProjectionSnapshot,
    options?: RunPresentationMutationOptions
  ): Promise<RunPresentationRef>
  finish(
    ref: RunPresentationRef,
    snapshot: RunProjectionSnapshot,
    options?: RunPresentationMutationOptions
  ): Promise<RunPresentationRef>
}

export type ExecutionRunBindingStatus = "active" | "degraded" | "finished" | "disabled"

export interface ExecutionRunBinding {
  id: string
  runId: string
  projectId?: string
  adapterId: string
  conversationKey: string
  status: ExecutionRunBindingStatus
  locale?: string
  sourceMessageId?: string
  deliveryTarget?: ConversationDeliveryTarget
  recipientUserId?: string
  recipientTeamId?: string
  deliveryMode: "native" | "card-edit" | "append" | "final-only"
  platformMessageId?: string
  presentationState?: Record<string, unknown>
  lastProjectedRevision: number
  createdAt: number
  updatedAt: number
}

export type ExecutionRunInterruptStatus = "pending" | "approved" | "denied" | "expired"

export interface ExecutionRunInterrupt {
  id: string
  runId: string
  projectId?: string
  type:
    | "tool_approval"
    | "workflow_approval"
    /** A team run's plan gate, asked through the surface that started the run. */
    | "plan_approval"
    /** The run is parked on a person; resolving it hands the work back. */
    | "human_handoff"
    /** A delegation held back from starting (quiet hours, operator sign-off). */
    | "delegation_approval"
    /**
     * A Bot run parked on a person mid-handler. Its own type because the
     * question is not a tool call and not a workflow node: it is "here is what
     * I intend to do next", asked by something nobody is watching, so the
     * surfaces that route pending decisions have to be able to tell it apart.
     */
    | "bot_approval"
    /** Squad pre-run capability audit: stale capability ids were found. */
    | "squad_capability_audit"
    /** Squad token budget exhausted, asking for an extension. */
    | "squad_budget"
    /** Every Squad teammate is unavailable, asking which to reset. */
    | "squad_deadlock"
    /** One Squad teammate was disqualified, asking to rejoin or skip. */
    | "squad_teammate_repair"
    /** The Squad lead proposes to re-plan mid-run. */
    | "squad_replan"
    /**
     * A Squad child cannot be replayed safely (unknown side effect, missing
     * checkpoint). Nothing is replayed until a person chooses how.
     */
    | "team_recovery"
  status: ExecutionRunInterruptStatus
  title: string
  toolName?: string
  requestDigest?: string
  expiresAt: number
  createdAt: number
  resolvedAt?: number
  resolvedBy?: ExecutionRunInitiator
  /**
   * Squad reviews only (ADR-0169). Which decision shape settles this
   * interrupt, redundant with `type` on purpose so a surface can branch on one
   * closed vocabulary.
   */
  reviewKind?: SquadReviewKind
  /**
   * Squad reviews only. Small, structured, non-sensitive context for the
   * decision form: a plan revision number, budget counts, teammate ids,
   * uncertain child ids. Never free text from a model or a user.
   */
  subject?: Record<string, unknown>
  /**
   * Squad reviews only. The validated decision, persisted on settlement so a
   * lifecycle that re-arms after a restart resumes exactly once with the
   * answer it was given. `feedback` has already passed redaction.
   */
  decision?: SquadReviewDecision & { outcome: "approve" | "deny" }
}

/** The interrupt type each Squad review kind parks on. */
export const SQUAD_REVIEW_INTERRUPT_TYPES: Record<SquadReviewKind, ExecutionRunInterrupt["type"]> =
  {
    plan: "plan_approval",
    capability_audit: "squad_capability_audit",
    budget_extension: "squad_budget",
    deadlock: "squad_deadlock",
    teammate_repair: "squad_teammate_repair",
    replan: "squad_replan",
    team_recovery: "team_recovery",
  }

export function squadReviewInterruptType(kind: SquadReviewKind): ExecutionRunInterrupt["type"] {
  return SQUAD_REVIEW_INTERRUPT_TYPES[kind]
}

/** The review kind behind an interrupt type, or `undefined` for a non-Squad interrupt. */
export function squadReviewKindForInterrupt(
  type: ExecutionRunInterrupt["type"]
): SquadReviewKind | undefined {
  for (const [kind, interruptType] of Object.entries(SQUAD_REVIEW_INTERRUPT_TYPES)) {
    if (interruptType === type) return kind as SquadReviewKind
  }
  return undefined
}
