export type TaskWorkspaceState = "active" | "ready" | "applied" | "conflict" | "expired"
export type TaskRunState = "running" | "settling" | "ready" | "failed" | "cancelled"
export type ChangeKind = "created" | "modified" | "deleted" | "renamed"
export type ContributionOrigin = "agent" | "user" | "unknown"
export type ResourceCaptureClass = "source" | "generated"
export type ResourceEventEvidence = "watcher" | "tool" | "reconcile"
export type ResourceTimelineCompleteness = "complete" | "resyncRequired" | "reconciled"

export interface ResourceTrackingPolicy {
  generatedOutputRoots: string[]
  autoDetect: boolean
}

export interface BeginTaskWorkspaceTurn {
  taskId: string
  sessionId: string
  runId: string
  parentRunId?: string
  agentId: string
  agentKind: string
  workspaceRoot: string
  base?: WorkspaceBaseSpec
  workspaceKey?: string
  executionRunId?: string
  traceId?: string
  traceSpanId?: string
  turnId?: string
  attemptId?: string
  providerAttemptId?: string
  surface?: string
  trackingPolicy?: ResourceTrackingPolicy
}

export type WorkspaceBaseSpec =
  | { kind: "workingState" }
  | { kind: "localHead" }
  | { kind: "remoteDefault" }
  | { kind: "gitRef"; gitRef: string }
  | {
      kind: "pullRequest"
      provider: string
      repo: string
      number: number
      fetchRef?: string
      headSha?: string
    }

export type WorkspaceEnvironmentKind = "managed" | "permanent" | "imported"
export type WorkspaceOwnerType = "user" | "imported" | "session" | "team" | "scheduled"
export type ManagedWorkspaceState =
  "provisioning" | "active" | "archived" | "conflict" | "restorable" | "removing" | "removed"

export interface ManagedWorkspaceRecord {
  workspaceId: string
  environmentKind: WorkspaceEnvironmentKind
  ownerType: WorkspaceOwnerType
  ownerRef: string | null
  state: ManagedWorkspaceState
  sourceRoot: string
  gitCommonDir: string | null
  base: WorkspaceBaseSpec
  head: string | null
  branch: string | null
  isolationKind: "gitWorktree" | "shadow"
  executionRoot: string
  snapshotTaskId: string | null
  sizeBytes: number | null
  lastUsedAt: number
  lockedBy: string | null
  pinned: boolean
  createdAt: number
}

export interface WorkspaceRootLease {
  bundleId: string
  workspaceId: string
  logicalRootId: string
  role: "primary" | "additional"
  aliasPath: string
}

/**
 * One directory linked into an execution root instead of copied — a package
 * cache (`node_modules`, `target`, `.venv`) a worktree would otherwise rebuild
 * from nothing on every acquisition. Both halves are repository-relative and
 * re-validated host-side.
 */
export interface WorkspaceCacheLink {
  source: string
  target: string
}

/**
 * How a repository wants its managed worktrees provisioned. Forwarded only
 * after the user approved that declaration on this device — see
 * `lib/project-environment/workspace-config-trust`.
 */
export interface WorkspaceProvisioning {
  /** Cone-mode sparse-checkout paths. Empty means a full checkout. */
  sparsePaths?: string[]
  /** Directories symlinked from the source checkout into the worktree. */
  cacheLinks?: WorkspaceCacheLink[]
  /** Gitignored paths copied in, which a worktree otherwise lacks. */
  include?: string[]
}

export interface AcquireWorkspaceBundle {
  ownerType: Exclude<WorkspaceOwnerType, "imported">
  ownerRef: string | null
  /**
   * Owning Workspace, stamped onto every Registry row this bundle provisions.
   * Registry rows are addressed by path and `(ownerType, ownerRef)`, and an
   * owner ref is a session or a team — never a project — so without this
   * "which execution slots does this project own" is unanswerable and deleting
   * a workspace cannot find the directories it produced.
   */
  projectId?: string
  environmentKind: Exclude<WorkspaceEnvironmentKind, "imported">
  base: WorkspaceBaseSpec
  roots: Array<{
    logicalRootId: string
    role: "primary" | "additional"
    sourceRoot: string
  }>
  /**
   * Repository-declared provisioning, applied to a Git worktree as part of
   * creating it. Absent for every caller that has no approved declaration —
   * the overwhelmingly common case.
   */
  provisioning?: WorkspaceProvisioning
}

export interface WorkspaceBundle {
  bundleId: string
  environmentKind: WorkspaceEnvironmentKind
  ownerType: WorkspaceOwnerType
  ownerRef: string | null
  state: ManagedWorkspaceState
  leases: WorkspaceRootLease[]
  lastUsedAt: number
  pinned: boolean
  createdAt: number
}

export interface WorkspaceBundleOutcome {
  bundleId: string
  applied: string[]
  rolledBack: string[]
  conflicts: Array<{ path: string; reason: string }>
  state: ManagedWorkspaceState
}

export interface BundleHandoffRootSelection {
  workspaceId: string
  logicalRootId: string
  selection: PatchSelection[]
}

export interface BundleHandoffRequest {
  bundleTurnId: string
  selections: BundleHandoffRootSelection[]
  allowIrreversible: boolean
}

export interface BundleHandoffOutcome {
  bundleTurnId: string
  request: BundleHandoffRequest
  outcome: WorkspaceBundleOutcome
}

export interface BundleHandoffUndoOutcome {
  bundleTurnId: string
  bundleId: string
  reverted: string[]
  reApplied: string[]
  conflicts: PatchConflict[]
  state: ManagedWorkspaceState
}

export interface BeginWorkspaceBundleTurn {
  primaryLogicalRootId: string
  run: BeginTaskWorkspaceTurn
}

export interface WorkspaceBundleTurnRunLease {
  workspaceId: string
  logicalRootIds: string[]
  run: TaskRun
}

export interface WorkspaceBundleTurnLease {
  bundleTurnId: string
  bundleId: string
  primaryLogicalRootId: string
  primaryAlias: string
  additionalAliases: string[]
  runs: WorkspaceBundleTurnRunLease[]
  state: TaskRunState
  createdAt: number
  settledAt: number | null
}

export interface WorkspaceBundleTurnRunOutcome {
  workspaceId: string
  logicalRootIds: string[]
  runId: string
  state: TaskRunState
  resources: ResourceChange[]
}

export interface WorkspaceBundleTurnOutcome {
  bundleTurnId: string
  bundleId: string
  state: TaskRunState
  runs: WorkspaceBundleTurnRunOutcome[]
  resources: ResourceChange[]
  settledAt: number
}

export interface WorkspaceLifecyclePolicy {
  activeDirectoryCap: number
  snapshotRetentionDays: number
  blobBudgetBytes: number
}

export interface WorkspaceMaintenanceRequest {
  now: number | null
}

export type WorkspaceMaintenanceEventKind =
  "reconciled" | "directoryReclaimed" | "snapshotExpired" | "failed"

export interface WorkspaceMaintenanceEvent {
  eventId: string
  kind: WorkspaceMaintenanceEventKind
  workspaceId: string | null
  occurredAt: number
  detail: string
}

export interface WorkspaceMaintenanceResult {
  startedAt: number
  finishedAt: number
  reconcile: WorkspaceReconcileOutcome
  reclaimedWorkspaceIds: string[]
  expiredSnapshotTaskIds: string[]
  removedBlobCount: number
  reclaimedBytes: number
  events: WorkspaceMaintenanceEvent[]
}

export type WorkspaceEnvironmentOwnership = "main" | "manual" | "managed" | "imported" | "permanent"

export type WorkspaceEnvironmentAction =
  | "open"
  | "remove"
  | "prune"
  | "adopt"
  | "pin"
  | "makePermanent"
  | "archive"
  | "restore"
  | "delete"
  | "review"
  | "handoff"
  | "createBranchHere"
  | "publish"

/** Canonical host-owned projection of Git worktrees and Registry environments. */
export interface WorkspaceEnvironmentSummary {
  environmentId: string
  workspaceId: string | null
  /**
   * Owning Workspace, so the inventory can be scoped to one project instead of
   * only ever being shown machine-wide. Absent for a directory on disk that no
   * project claims.
   */
  projectId?: string
  path: string
  sourceRoot: string
  ownership: WorkspaceEnvironmentOwnership
  ownerType: WorkspaceOwnerType | null
  ownerRef: string | null
  state: ManagedWorkspaceState | null
  branch: string | null
  head: string | null
  locked: boolean
  lockReason: string | null
  prunable: boolean
  pruneReason: string | null
  base: WorkspaceBaseSpec | null
  pinned: boolean
  allowedActions: WorkspaceEnvironmentAction[]
}

export interface WorkspaceReconcileOutcome {
  reclaimed: string[]
  orphaned: string[]
  imported: Array<{
    sourceRoot: string
    executionRoot: string
    gitCommonDir: string | null
    branch: string | null
  }>
}

export interface TaskWorkspace {
  taskId: string
  sessionId: string
  workspaceRoot: string
  state: TaskWorkspaceState
  revision: number
  createdAt: number
  expiresAt: number
  pinned: boolean
}

export interface TaskRun {
  runId: string
  taskId: string
  parentRunId: string | null
  agentId: string
  agentKind: string
  executionRoot: string
  isolationKind: "gitWorktree" | "shadow"
  isolationRef: string | null
  workspaceId: string | null
  base: WorkspaceBaseSpec
  workspaceKey: string | null
  executionRunId: string | null
  traceId: string | null
  turnId: string | null
  attemptId: string | null
  providerAttemptId: string | null
  surface: string | null
  trackingPolicy: ResourceTrackingPolicy
  baselineRevision: number
  state: TaskRunState
  createdAt: number
  settledAt: number | null
}

export interface ResourceChange {
  runId: string
  path: string
  oldPath: string | null
  kind: ChangeKind
  origin: ContributionOrigin
  agentId: string | null
  mediaType: string
  size: number
  hash: string | null
  beforeHash: string | null
  insertions: number | null
  deletions: number | null
  binary: boolean
  resourceKind: "file" | "symlink"
  beforeMode: number | null
  afterMode: number | null
  sensitive: boolean
  revision: number
  captureClass: ResourceCaptureClass
  contentCaptured: boolean
}

export type ResourceEventKind =
  "created" | "modified" | "deleted" | "renamed" | "any" | "gap" | "resync"

export interface ResourceEvent {
  eventId: string
  taskId: string
  runId: string
  seq: number
  observedAt: number
  kind: ResourceEventKind
  path: string | null
  oldPath: string | null
  captureClass: ResourceCaptureClass
  origin: ContributionOrigin
  agentId: string | null
  evidence: ResourceEventEvidence
  toolCallId: string | null
  mediaType: string | null
  size: number | null
  resourceKind: "file" | "symlink" | null
  sensitive: boolean
  provisional: boolean
  overflow: boolean
  resyncRequired: boolean
  reconciled: boolean
}

export interface ResourceEventCounts {
  created: number
  modified: number
  deleted: number
  renamed: number
  source: number
  generated: number
}

export interface TaskResourceSummary {
  runId: string
  counts: ResourceEventCounts
  eventCount: number
  overflowCount: number
  completeness: ResourceTimelineCompleteness
}

export interface TaskResourceManifest {
  schemaVersion: number
  exportedAt: number
  task: TaskWorkspace
  runs: TaskRun[]
  resources: ResourceChange[]
  events: ResourceEvent[]
  summaries: TaskResourceSummary[]
}

export interface ResourceRead {
  content: string | null
  encoding: "utf8" | "binary"
  mediaType: string
  size: number
  hash: string
  truncated: boolean
  nextOffset: number | null
  sensitive: boolean
}

export interface DownloadHandle {
  handleId: string
  size: number
  hash: string
  mediaType: string
  sensitive: boolean
  chunkBytes: number
}

export interface TransferChunk {
  handleId: string
  offset: number
  dataBase64: string
  length: number
  chunkHash: string
  nextOffset: number | null
  complete: boolean
  etag: string
}

export interface UploadHandle {
  handleId: string
  nextOffset: number
  expectedSize: number
  expectedHash: string
  chunkBytes: number
  expiresInMs: number
}

export interface TaskWorkspaceResourceEvent {
  taskId: string
  runId: string
  revision: number
  changes: Array<{ path: string; oldPath?: string; kind: ResourceEventKind }>
  overflow: boolean
  resyncRequired: boolean
}

export interface PatchSelection {
  path: string
  hunkIds: string[]
}

export interface PatchSet {
  patchId: string
  taskId: string
  runId: string
  state: "ready" | "applied" | "reverted" | "conflict"
  baseRevision: number
  appliedRevision: number | null
  reversible: boolean
  files: Array<{
    path: string
    oldPath: string | null
    kind: ChangeKind
    resourceKind: "file" | "symlink"
    beforeHash: string | null
    afterHash: string | null
    beforeMode: number | null
    afterMode: number | null
    binary: boolean
    hunks: Array<{
      id: string
      header: string
      forwardPatchHash: string
      inversePatchHash: string
      additions?: number
      deletions?: number
    }>
  }>
  /** Missing/false on patch rows written before durable selection tracking. */
  appliedSelectionKnown?: boolean
  /** Empty means the successful apply selected every file. */
  appliedSelection?: PatchSelection[]
  createdAt: number
}

export interface ApplyOutcome {
  state: "ready" | "applied" | "reverted" | "conflict"
  revision: number
  conflicts: Array<{ path: string; reason: string }>
}
