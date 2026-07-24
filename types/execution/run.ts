/** Stable execution semantics shared by agent turns, workflows, and IM presenters. */

import type { ConversationDeliveryTarget } from "@/types/connectors/event"

export type ExecutionRunKind = "agent-turn" | "workflow" | "plan" | "goal" | "team" | "scheduled"

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
  "stop" | "pause" | "resume" | "approve" | "deny" | "retry" | "open_details"

export interface RunArtifactSnapshot {
  id: string
  title: string
  url?: string
  mimeType?: string
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

export interface ExecutionRun {
  id: string
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
  type: "tool_approval" | "workflow_approval"
  status: ExecutionRunInterruptStatus
  title: string
  toolName?: string
  requestDigest?: string
  expiresAt: number
  createdAt: number
  resolvedAt?: number
  resolvedBy?: ExecutionRunInitiator
}
