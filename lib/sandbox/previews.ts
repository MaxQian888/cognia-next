/** Host-owned preview capabilities. Never persist bootstrap URLs. */
import { transport } from "@/lib/tauri/transport-instance"
import type { DevicePlatform } from "@/types/mobile/paired-device"
import { collectPages, type Page } from "@/lib/tauri/companion-paging"
import type { ManagedWorkspaceState, WorkspacePortLease } from "@/lib/task-workspace/types"
import type { EnvironmentRuntimePort } from "@/lib/project-environment/environment-client"

export type PreviewPort =
  { kind: "fixed"; port: number } | { kind: "workspace-lease-offset"; offset: number }

export type PreviewAudience =
  | { kind: "localOwner" }
  /**
   * One paired device (ADR-0231 phase 2). The Host mints no bootstrap secret:
   * it serves the grant on `/api/sandbox/previews/<id>/` to that device's own
   * DPoP credentials only, and the owner cannot open it locally.
   */
  | { kind: "pairedDevice"; deviceId: string }

/**
 * Where a paired-device grant can be opened. Only the desktop app has the
 * native loopback relay that signs every proxied request with the device key.
 * Phones and browsers have no such path (a WebView cannot attach DPoP and the
 * WAN carrier transports RPC frames, not HTTP streams), so for them the
 * audience is intentionally inert: listed, labelled, never selectable.
 */
export type PairedPreviewSupport = "desktopRelay" | "unsupported"

export function pairedPreviewSupport(platform: DevicePlatform): PairedPreviewSupport {
  return platform === "desktop" ? "desktopRelay" : "unsupported"
}

export function pairedPreviewDeviceId(grant: Pick<PreviewGrantV1, "audience">): string | null {
  return grant.audience.kind === "pairedDevice" ? grant.audience.deviceId : null
}

/** What the Host lists to the paired device itself. Nothing here is a credential. */
export interface PairedPreviewSummary {
  id: string
  projectId: string
  workspaceId: string
  resolvedPort: number
  expiresAt: number
  /** `/api/sandbox/previews/<id>/`, the only path the native relay accepts. */
  relayPath: string
}

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
  /**
   * Local owner: a one-shot, 60-second bootstrap capability, available only in
   * memory. Paired device: the device route path, which is not a credential.
   */
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
