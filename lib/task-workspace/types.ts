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
    hunks: Array<{ id: string; header: string }>
  }>
  createdAt: number
}

export interface ApplyOutcome {
  state: "ready" | "applied" | "reverted" | "conflict"
  revision: number
  conflicts: Array<{ path: string; reason: string }>
}
