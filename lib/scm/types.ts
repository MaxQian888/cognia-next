/**
 * Wire types of the agent changeset and integration queue (ADR-0227).
 *
 * Mirrors `crates/cognia-task-workspace/src/types.rs` field for field
 * (`serde(rename_all = "camelCase")`); the host is the authority for every
 * state and gate here, and the renderer only renders and requests.
 */

import type { WorkspaceProvisioning } from "@/lib/task-workspace/types"

export type ChangesetFileStatus = "added" | "modified" | "deleted" | "renamed" | "typeChanged"

export interface ChangesetFile {
  path: string
  oldPath: string | null
  status: ChangesetFileStatus
  insertions: number | null
  deletions: number | null
  binary: boolean
  sensitive: boolean
  /** Withheld from the changeset's tree; never reaches an integration. */
  excluded: boolean
}

export type ChangesetState =
  | "draft"
  | "ready"
  | "approved"
  | "changesRequested"
  | "queued"
  | "integrating"
  | "merged"
  | "conflicted"
  | "failed"
  | "rolledBack"
  | "abandoned"

export type ChangesetReviewVerdict = "approve" | "requestChanges" | "comment" | "unavailable"
export type ChangesetReviewer = "agent" | "user" | "deterministic"
export type ChangesetRiskTier = "low" | "medium" | "high"
export type ChangesetFindingSeverity = "info" | "warning" | "critical"

export interface ChangesetFinding {
  path: string
  severity: ChangesetFindingSeverity
  note: string
}

export interface ChangesetReview {
  /** The head this review read; the host refuses it for any other. */
  headSha: string
  verdict: ChangesetReviewVerdict
  reviewer: ChangesetReviewer
  riskTier: ChangesetRiskTier
  /** Reason codes (`assess-change-risk.ts`, review-agent reasons). */
  reasons: string[]
  findings: ChangesetFinding[]
  requiresHumanApproval: boolean
  recordedAt: number
}

export type ChangesetCheckOutcome = "passed" | "failed" | "inconclusive"

export interface ChangesetCheck {
  /** The commit whose tree was tested. */
  headSha: string
  profileId: string
  outcome: ChangesetCheckOutcome
  tier: string | null
  reportDigest: string | null
  logTail: string | null
  ranAt: number
}

export interface ChangesetApproval {
  headSha: string
  approver: string
  approvedAt: number
}

export interface AgentChangeset {
  changesetId: string
  runId: string | null
  taskId: string | null
  /** The conversation the change came from. */
  sessionId: string | null
  agentId: string | null
  agentKind: string | null
  /** e.g. the Agent Team run id. */
  ownerRef: string | null
  workspaceId: string
  executionRoot: string
  repoCommonDir: string
  sourceRoot: string
  targetRef: string
  baseSha: string
  headSha: string
  /** `refs/cognia/changesets/<id>`, pinning the head against GC. */
  changeRef: string
  title: string
  files: ChangesetFile[]
  dependsOn: string[]
  state: ChangesetState
  review: ChangesetReview | null
  checks: ChangesetCheck[]
  requiredChecks: string[]
  approval: ChangesetApproval | null
  integrationId: string | null
  mergedSha: string | null
  version: number
  createdAt: number
  updatedAt: number
}

export interface CaptureChangeset {
  workspaceId: string
  targetRef?: string | null
  title: string
  dependsOn?: string[]
  requiredChecks?: string[]
  /** Re-capture an existing changeset after its agent revised it. */
  changesetId?: string | null
}

export interface ChangesetFilter {
  repoCommonDir?: string | null
  ownerRef?: string | null
  sessionId?: string | null
  states?: ChangesetState[] | null
}

export type EligibilityGap =
  | { kind: "missingReview" }
  | { kind: "reviewNotApproved" }
  | { kind: "missingCheck"; profile: string }
  | { kind: "checkNotPassed"; profile: string; outcome: ChangesetCheckOutcome }
  | { kind: "missingHumanApproval" }
  | { kind: "staleHead" }

/** States from which nothing further happens to a changeset. */
export const TERMINAL_CHANGESET_STATES: ReadonlySet<ChangesetState> = new Set([
  "merged",
  "rolledBack",
  "abandoned",
])

// ── Integration queue ────────────────────────────────────────────────────────

export type IntegrationStrategy = "merge" | "rebase"
export type IntegrationConflictPolicy = "skip" | "stop"

export type IntegrationState =
  | "planned"
  | "preparing"
  | "prepared"
  | "publishing"
  | "published"
  | "stale"
  | "conflicted"
  | "failed"
  | "aborted"
  | "interrupted"
  | "rolledBack"

export type IntegrationItemOutcome =
  "pending" | "merged" | "rerereResolved" | "conflicted" | "skipped" | "dropped"
export type IntegrationPrediction = "mergeTree" | "overlapOnly"

export interface IntegrationItem {
  changesetId: string
  headSha: string
  outcome: IntegrationItemOutcome
  conflictFiles: string[]
  /** The commit this changeset became in the candidate (merge or last replayed). */
  commitSha: string | null
}

export interface RefTransition {
  refName: string
  oldSha: string
  newSha: string
  reason: string
  at: number
}

export interface IntegrationFailure {
  code: string
  message: string
}

export interface IntegrationRun {
  integrationId: string
  repoCommonDir: string
  targetRef: string
  strategy: IntegrationStrategy
  onConflict: IntegrationConflictPolicy
  /** The target tip the run composed on; publish swaps only from this. */
  expectedOldSha: string
  candidateSha: string | null
  resultSha: string | null
  state: IntegrationState
  items: IntegrationItem[]
  /** The reused per-repository integration worktree. */
  worktreePath: string | null
  attempt: number
  opLog: RefTransition[]
  /** Checks bound to the candidate. */
  checks: ChangesetCheck[]
  /**
   * Every acceptance profile the candidate owes before publish: the prepare
   * request's plus each composed changeset's. Persisted by the host, so a
   * publish that names fewer cannot skip one.
   */
  requiredChecks: string[]
  /** The prepare request's own checks, kept across drops and rebuilds. */
  requestedChecks: string[]
  error: IntegrationFailure | null
  createdAt: number
  updatedAt: number
}

export interface IntegrationOverlap {
  /** A changeset id, or `target` for a conflict with the target tip. */
  a: string
  b: string
  files: string[]
}

export interface IntegrationAnalysis {
  order: string[]
  predictedConflicts: IntegrationOverlap[]
  overlaps: IntegrationOverlap[]
  prediction: IntegrationPrediction
  cycles: string[][]
}

export interface PrepareIntegration {
  changesetIds: string[]
  /** Acceptance profiles the candidate must pass, bound to the run at prepare. */
  requiredChecks?: string[]
  targetRef: string
  strategy: IntegrationStrategy
  onConflict: IntegrationConflictPolicy
  /** The repository's provisioning (cache links, sparse paths) for the integration worktree. */
  provisioning?: WorkspaceProvisioning | null
  integrationId?: string | null
}

export interface IntegrationRunFilter {
  repoCommonDir?: string | null
  targetRef?: string | null
  states?: IntegrationState[] | null
}

/** Items that made it into the candidate. */
export function composedItems(run: Pick<IntegrationRun, "items">): IntegrationItem[] {
  return run.items.filter((item) => item.outcome === "merged" || item.outcome === "rerereResolved")
}

/** States in which the run holds its repository's integration worktree. */
export const ACTIVE_INTEGRATION_STATES: ReadonlySet<IntegrationState> = new Set([
  "preparing",
  "prepared",
  "publishing",
  "stale",
])
