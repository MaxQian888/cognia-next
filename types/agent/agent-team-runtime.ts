/** Durable local AgentTeam runtime contracts. All timestamps are epoch milliseconds. */

export type AgentTeamWriteMode = "single-writer" | "isolated-parallel"

export interface AgentTeamRepositoryBinding {
  id: string
  role: "primary" | "dependency"
  path: string
  writable: boolean
  baseBranch?: string
  dependsOn?: string[]
}

export interface AgentTeamEnvironmentRef {
  environmentId: string
  versionId: string
}

export interface AgentTeamResourcePolicy {
  /** Larger numbers run first; aging still prevents starvation. */
  priority: number
  maxConcurrentChildren: number
  maxTokens?: number
  maxCostUsd?: number
  maxWallTimeMs?: number
}

export interface AgentTeamEvidencePolicy {
  requireActivity: boolean
  requireOutcome: boolean
  requireCodeDiff: boolean
  requireVerification: boolean
  requireVisualForUi: boolean
}

export interface AgentTeamRetrospectivePolicy {
  enabled: boolean
  requireApproval: true
  redactBeforeModel: true
}

export interface AgentTeamGithubDeliveryPolicy {
  enabled: boolean
  stackedPullRequests: boolean
  minLayers: number
  maxLayers: number
  mergeMode: "approved-bottom-up"
}

export type AgentTeamRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "sleeping"
  | "recovering"
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"

export type AgentTeamChildStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "sleeping"
  | "recovering"
  | "needs_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "terminated"

export interface AgentTeamResourceUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd?: number
  wallTimeMs: number
  toolTimeMs: number
  attempts: number
  failures: number
}

export interface AgentTeamRunRecord {
  id: string
  teamId: string
  projectId?: string
  objective: string
  status: AgentTeamRunStatus
  priority: number
  queueEnteredAt?: number
  decisionVersion: number
  environmentVersionId?: string
  activeWriterRepositoryId?: string
  recoveryReason?: string
  resourceUsage?: AgentTeamResourceUsage
  createdAt: number
  startedAt?: number
  completedAt?: number
  updatedAt: number
}

export interface AgentTeamChildRun {
  id: string
  runId: string
  teamId: string
  teammateId: string
  taskId: string
  repositoryId: string
  status: AgentTeamChildStatus
  attempt: number
  sessionId?: string
  /** Authenticated Companion device identity; never supplied by the worker. */
  hostRef?: string
  executionFingerprint?: string
  remoteSessionId?: string
  dispatchLeaseId?: string
  dispatchLeaseExpiresAt?: number
  lastRemoteEventId?: string
  waitingReason?: string
  runtime?: string
  decisionVersion?: number
  workspacePath?: string
  branch?: string
  fileOwnership?: string[]
  writerLeaseId?: string
  lastCheckpointId?: string
  lastTrajectorySequence?: number
  pendingSteeringCount?: number
  resourceUsage: AgentTeamResourceUsage
  error?: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  updatedAt: number
}

export type AgentTeamTrajectoryKind =
  | "child_created"
  | "model_turn_started"
  | "model_turn_completed"
  | "tool_intent"
  | "tool_result"
  | "workspace_changed"
  | "test_result"
  | "decision_proposed"
  | "decision_accepted"
  | "steering_queued"
  | "steering_delivered"
  | "steering_applied"
  | "checkpoint"
  | "manual_takeover_started"
  | "manual_takeover_completed"
  | "run_controlled"
  | "child_completed"
  | "child_failed"

export interface AgentTeamTrajectoryEvent {
  id: string
  runId: string
  childRunId?: string
  sequence: number
  kind: AgentTeamTrajectoryKind
  correlationId: string
  /** Inline payloads are bounded; larger content is referenced by contentHash. */
  payload?: Record<string, unknown>
  contentHash?: string
  createdAt: number
}

export interface AgentTeamSideEffect {
  id: string
  kind: string
  idempotencyKey?: string
  state: "intent" | "completed" | "failed" | "unknown"
  replay: "safe" | "unsafe" | "unknown"
}

export interface AgentTeamCheckpoint {
  id: string
  runId: string
  childRunId?: string
  trajectorySequence: number
  decisionVersion: number
  replay: "safe" | "needs_input"
  sideEffects: AgentTeamSideEffect[]
  workspaceCommit?: string
  createdAt: number
}

export type AgentTeamDecisionStatus = "constraint" | "proposed" | "accepted" | "rejected"

export interface AgentTeamDecision {
  id: string
  runId: string
  version: number
  status: AgentTeamDecisionStatus
  title: string
  detail: string
  authorId: string
  evidenceIds: string[]
  impacts?: Array<"mechanical" | "public_api" | "migration" | "security" | "user_constraint">
  compatibilityScopes?: string[]
  conflict?: {
    resolution: "compatible" | "mechanical" | "escalate"
    reason: string
    withDecisionIds: string[]
  }
  immutable: boolean
  supersedesId?: string
  createdAt: number
  resolvedAt?: number
}

export type AgentTeamSteeringStatus = "queued" | "delivered" | "applied" | "rejected"

export interface AgentTeamSteeringReceipt {
  id: string
  runId: string
  childRunId: string
  message: string
  status: AgentTeamSteeringStatus
  reason?: string
  createdAt: number
  deliveredAt?: number
  appliedAt?: number
  updatedAt: number
}

export type AgentTeamEvidenceKind =
  | "activity"
  | "outcome"
  | "command"
  | "test"
  | "diff"
  | "commit"
  | "log"
  | "screenshot"
  | "recording"
  | "pull_request"
  | "ci"

export interface AgentTeamEvidence {
  id: string
  runId: string
  childRunId?: string
  taskId: string
  kind: AgentTeamEvidenceKind
  title: string
  contentHash?: string
  url?: string
  metadata?: Record<string, unknown>
  createdAt: number
}

export type AgentTeamDeliveryNodeStatus =
  | "blocked"
  | "ready"
  | "publishing"
  | "ci_pending"
  | "needs_remediation"
  | "awaiting_approval"
  | "merging"
  | "merged"
  | "failed"
  | "cancelled"

export interface AgentTeamDeliveryNode {
  id: string
  graphId: string
  runId: string
  repositoryId: string
  title: string
  order: number
  dependsOn: string[]
  branch: string
  baseBranch: string
  status: AgentTeamDeliveryNodeStatus
  pullRequestNumber?: number
  pullRequestUrl?: string
  headSha?: string
  error?: string
  createdAt: number
  updatedAt: number
}

export interface AgentTeamDeliveryGraph {
  id: string
  runId: string
  status: "draft" | "running" | "awaiting_approval" | "completed" | "failed"
  approvedAt?: number
  createdAt: number
  updatedAt: number
}

export type AgentTeamLearningKind =
  "prompt" | "environment" | "memory_useful" | "memory_misleading" | "decomposition"

export interface AgentTeamLearningProposal {
  id: string
  kind: AgentTeamLearningKind
  title: string
  before?: string
  after: string
  status: "pending" | "approved" | "rejected"
  resolvedAt?: number
}

export interface AgentTeamRetrospective {
  id: string
  runId: string
  status: "draft" | "pending_approval" | "applied" | "rejected"
  issueTimeline: Array<{ at: number; summary: string; childRunId?: string }>
  proposals: AgentTeamLearningProposal[]
  contentHash?: string
  createdAt: number
  updatedAt: number
}

export interface AgentTeamContentObject {
  hash: string
  mimeType: string
  byteLength: number
  data: Uint8Array
  createdAt: number
}
