/** Host-owned, local-owner preview capabilities. Never persist bootstrap URLs. */
import { transport } from "@/lib/tauri/transport-instance"
import { collectPages, type Page } from "@/lib/tauri/companion-paging"
import type { ManagedWorkspaceState, WorkspacePortLease } from "@/lib/task-workspace/types"
import type { EnvironmentRuntimePort } from "@/lib/project-environment/environment-client"

export type PreviewPort =
  { kind: "fixed"; port: number } | { kind: "workspace-lease-offset"; offset: number }

export type PreviewAudience =
  | { kind: "localOwner" }
  /** Inert until phase 2: the Host refuses this audience. */
  | { kind: "pairedDevice"; deviceId: string }

export interface PreviewGrantV1 {
  version: number
  id: string
  projectId: string
  workspaceId: string
  provider: string
  containerId: string
  runtimeGeneration: string
  port: PreviewPort
  resolvedPort: number
  portLease: WorkspacePortLease | null
  audience: PreviewAudience
  createdAt: number
  expiresAt: number
  revision: number
  revoked: boolean
  origin: string
}

export interface CreateSandboxPreview {
  projectId: string
  workspaceId: string
  provider: string
  containerId: string
  port: PreviewPort
  expiresInSeconds?: number
  /** Loopback is inert: the Host refuses numeric origins because cookies ignore ports. */
  originMode?: "localhost" | "loopback"
  audience?: PreviewAudience
}

export interface CreatedSandboxPreview {
  grant: PreviewGrantV1
  /** A one-shot, 60-second bootstrap capability, available only in memory. */
  bootstrapUrl: string
}

export interface SandboxPreviewTarget {
  workspaceId: string
  provider: string
  containerId: string
  executionRoot: string
  ports: EnvironmentRuntimePort[]
  workspaceState: ManagedWorkspaceState
  portLease: WorkspacePortLease | null
}

export interface SandboxPreviewContext {
  targets: SandboxPreviewTarget[]
  snapshotUsageBytes: number
  sandboxSnapshotBudgetBytes: number
}

export function sandboxPreviewContext(projectId: string): Promise<SandboxPreviewContext> {
  return transport.call("sandbox_preview_context", { projectId })
}

export function sandboxPreviewCreate(
  request: CreateSandboxPreview
): Promise<CreatedSandboxPreview> {
  return transport.call("sandbox_preview_create", { request })
}

export function sandboxPreviewList(
  projectId: string,
  workspaceId?: string
): Promise<PreviewGrantV1[]> {
  return collectPages(
    (pageToken) =>
      transport.call<Page<PreviewGrantV1>>("sandbox_preview_list", {
        projectId,
        ...(workspaceId ? { workspaceId } : {}),
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
    { requireComplete: true }
  )
}

export function sandboxPreviewRevoke(grantId: string): Promise<PreviewGrantV1> {
  return transport.call("sandbox_preview_revoke", { grantId })
}

export function sandboxPreviewOpen(grantId: string): Promise<CreatedSandboxPreview> {
  return transport.call("sandbox_preview_open", { grantId })
}
