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
  }
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

export interface RunControlCommand {
  runId: string
  action: RunControlAction
  idempotencyKey: string
  expectedRevision: number
  actor: ExecutionRunInitiator
  interruptId?: string
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
  status: ExecutionRunInterruptStatus
  title: string
  toolName?: string
  requestDigest?: string
  expiresAt: number
  createdAt: number
  resolvedAt?: number
  resolvedBy?: ExecutionRunInitiator
}
