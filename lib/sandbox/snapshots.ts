/** Cold filesystem snapshots. The Host owns all paths, image identities and leases. */
import { transport } from "@/lib/tauri/transport-instance"
import type { TaskWorkspace, WorkspacePortLease } from "@/lib/task-workspace/types"

export type SandboxSnapshotPhase =
  "preparing" | "workspaceCaptured" | "imageCommitted" | "ready" | "tombstoned"

export interface SandboxSnapshot {
  snapshotId: string
  deploymentId: string
  projectId: string
  taskId: string
  workspaceRoot: string
  exclusions: string[]
  runtime: Record<string, unknown>
  checkpointId: string | null
  imageId: string | null
  imageBytes: number
  phase: SandboxSnapshotPhase
  createdAt: number
  expiresAt: number
  pinned: boolean
}

export interface CreateSandboxSnapshot {
  projectId: string
  workspaceId: string
  provider: string
  containerId: string
  /** Workspace-relative paths or directory prefixes; the checkpoint manifest records each exclusion. */
  exclusions?: string[]
}

export interface ForkSandboxSnapshot {
  snapshotId: string
  taskId: string
  sessionId: string
}

export interface RestoreSandboxSnapshot extends ForkSandboxSnapshot {
  /** Only archived/restorable workspaces can be restored in place. Others fork. */
  workspaceId?: string | null
}

export interface ForkedSandboxSnapshot {
  workspace: {
    workspaceId: string
    task: TaskWorkspace
    executionRoot: string
    portLease: WorkspacePortLease
  }
  provider: string
  containerId: string
  restoredInPlace: boolean
}

export function sandboxSnapshotCreate(request: CreateSandboxSnapshot): Promise<SandboxSnapshot> {
  return transport.call("sandbox_snapshot_create", { request })
}

export function sandboxSnapshotList(projectId: string): Promise<SandboxSnapshot[]> {
  return transport.call("sandbox_snapshot_list", { projectId })
}

export function sandboxSnapshotGet(snapshotId: string): Promise<SandboxSnapshot> {
  return transport.call("sandbox_snapshot_get", { snapshotId })
}

export function sandboxSnapshotDelete(snapshotId: string): Promise<SandboxSnapshot> {
  return transport.call("sandbox_snapshot_delete", { snapshotId })
}

export function sandboxSnapshotPin(snapshotId: string, pinned: boolean): Promise<SandboxSnapshot> {
  return transport.call("sandbox_snapshot_pin", { snapshotId, pinned })
}

export function sandboxSnapshotFork(request: ForkSandboxSnapshot): Promise<ForkedSandboxSnapshot> {
  return transport.call("sandbox_snapshot_fork", { request })
}

export function sandboxSnapshotRestore(
  request: RestoreSandboxSnapshot
): Promise<ForkedSandboxSnapshot> {
  return transport.call("sandbox_snapshot_restore", { request })
}
