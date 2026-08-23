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

export type WorkspaceBaseSpec =
  | { kind: "workingState" }
  | { kind: "localHead" }
  | { kind: "remoteDefault" }
  | { kind: "gitRef"; gitRef: string }
  | { kind: "pullRequest"; provider: string; repo: string; number: number }

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

export interface AcquireWorkspaceBundle {
  ownerType: Exclude<WorkspaceOwnerType, "imported">
  ownerRef: string | null
  environmentKind: Exclude<WorkspaceEnvironmentKind, "imported">
  base: WorkspaceBaseSpec
  roots: Array<{
    logicalRootId: string
    role: "primary" | "additional"
    sourceRoot: string
  }>
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

export interface WorkspaceLifecyclePolicy {
  activeDirectoryCap: number
  snapshotRetentionDays: number
  blobBudgetBytes: number
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
