export type SessionExecutionLocation = "local" | "managedWorktree"

export type SessionWorkspaceBaseSpec =
  | { kind: "workingState" }
  | { kind: "localHead" }
  | { kind: "remoteDefault" }
  | { kind: "gitRef"; gitRef: string }
  | { kind: "pullRequest"; provider: string; repo: string; number: number }

export interface SessionExecutionRootLease {
  logicalRootId: string
  role: "primary" | "additional"
  aliasPath: string
  workspaceId?: string
}

export interface SessionExecutionBinding {
  mode: "local" | "managed" | "permanent"
  environmentId?: string
  bundleId?: string
  base: SessionWorkspaceBaseSpec
  roots: SessionExecutionRootLease[]
}

export type SessionWorkspaceBinding =
  { kind: "project"; projectId: string } | { kind: "managed"; workspaceId: string }

export type ManagedWorkspaceAvailability = "available" | "missing-on-device" | "deleted"

/**
 * Device-local materialization metadata. Portable sync deliberately removes
 * this object and reconstructs a `missing-on-device` state on the receiver.
 */
export interface ManagedWorkspaceDeviceState {
  availability: ManagedWorkspaceAvailability
  localRoot?: string
  deletedRoot?: string
  materializedAt?: number
  reboundAt?: number
  deletedAt?: number
}

export type ManagedWorktreeLifecycleState =
  | "requested"
  | "creating"
  | "initializing"
  | "ready"
  | "active"
  | "handingOff"
  | "conflict"
  | "snapshotted"
  | "pruned"
  | "restoring"
  | "failed"

export interface TaskWorkspaceBinding {
  taskId: string
  workspaceKey: string
  runId?: string
}

export interface ManagedWorktreeLifecycle {
  state: ManagedWorktreeLifecycleState
  createdAt: number
  updatedAt: number
  expiresAt?: number
  pinned: boolean
  snapshotId?: string
  lastError?: string
}

/** Durable execution identity shared by interactive and scheduled chat turns. */
export interface SessionExecutionContext {
  /** Canonical execution identity for new rows. Missing only on legacy data. */
  execution?: SessionExecutionBinding
  location: SessionExecutionLocation
  /** Portable ownership identity. Optional only for legacy persisted rows. */
  workspaceBinding?: SessionWorkspaceBinding
  /** Present only for a managed binding and never authoritative across devices. */
  managedWorkspace?: ManagedWorkspaceDeviceState
  /** @deprecated Compatibility mirror for pre-binding consumers. */
  projectId: string
  /** @deprecated Device-local compatibility mirror; stripped from managed sync rows. */
  projectRoot: string
  rootId?: string
  environmentId?: string
  taskWorkspace: TaskWorkspaceBinding
  baseRef?: string
  branch?: string
  worktreePath?: string
  lifecycle?: ManagedWorktreeLifecycle
}
