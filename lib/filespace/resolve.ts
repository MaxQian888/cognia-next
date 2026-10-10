/**
 * Project one conversation into its FileSpace (ADR-0222 §1).
 *
 * Pure. Every input is a binding that already exists; this module decides
 * only how they are *named*:
 *
 * - `/workspace` is where the conversation runs — `resolveExecutionRoot`'s
 *   answer, so the panel, links and the agent agree with the dock editor and
 *   the edit-review bridge about which directory that is.
 * - `/roots/<id>` is every other directory the conversation can reach: each
 *   additional execution lease, plus any workspace root no lease covers (those
 *   are forwarded to the agent as `additionalDirectories`, so they are part of
 *   what this conversation can touch whether or not a Bundle leased them).
 * - `/uploads` and `/artifacts` are the conversation's Dexie-held files,
 *   read-only here.
 *
 * Deliberately absent: a `/shared` mount for the project checkout of a
 * worktree-bound conversation. Showing the live checkout beside the worktree
 * copy it was cut from is how people edit the wrong tree.
 */

import { containerPathFor } from "@/lib/sandbox/docker-policy-attestation"
import { primaryRootOf } from "@/lib/workspace/roots"
import { resolveExecutionRoot } from "@/lib/workspace/session-root"
import type { SessionExecutionContext } from "@/types/execution-context"
import type {
  ConversationFileSpace,
  FileSpaceMount,
  FileSpaceMountStatus,
  FileSpaceMountStatusReason,
} from "@/types/filespace"
import type { DockerSandboxConfig } from "@/types/sandbox"
import type { WorkspaceRoot } from "@/types/workspace"

export const WORKSPACE_MOUNT_PATH = "/workspace"
export const UPLOADS_MOUNT_PATH = "/uploads"
export const ARTIFACTS_MOUNT_PATH = "/artifacts"
export const ROOTS_MOUNT_PREFIX = "/roots"
/** `hostId` for this machine. */
export const LOCAL_FILESPACE_HOST_ID = "local"

/** Which machine owns the disk mounts, and whether this client can reach it. */
export interface FileSpaceHostState {
  /** `"local"`, or the remote host id execution is routed to (ADR-0082). */
  id: string
  label?: string
  /** Whether a filesystem backend exists here at all (Tauri, or a paired companion). */
  fsBackend: boolean
  /** False when the remote host's transport is down. Always true for `"local"`. */
  reachable: boolean
}

export interface ResolveConversationFileSpaceInput {
  sessionId: string
  /** The session row, or `null` when it does not exist (deleted, or never synced here). */
  session: { projectId?: string; executionContext?: SessionExecutionContext } | null
  /** The workspace the session belongs to, when loaded. */
  project: { id: string; roots: WorkspaceRoot[] } | null
  hasUploads: boolean
  hasArtifacts: boolean
  /** The Docker sandbox connection bound to this conversation, if any. */
  dockerSandbox?: DockerSandboxConfig | null
  host: FileSpaceHostState
}

export function resolveConversationFileSpace(
  input: ResolveConversationFileSpaceInput
): ConversationFileSpace {
  const base = {
    sessionId: input.sessionId,
    hostId: input.host.id,
    ...(input.host.id !== LOCAL_FILESPACE_HOST_ID && input.host.label
      ? { hostLabel: input.host.label }
      : {}),
  }
  if (!input.session) return { ...base, status: "deleted", mounts: [] }

  const mounts = [
    ...diskMounts(input.session.executionContext, input.project, input),
    ...dexieMounts(input),
  ]
  const status = mounts.some((mount) => mount.status === "available") ? "available" : "offline"
  return { ...base, status, mounts }
}

function diskMounts(
  context: SessionExecutionContext | undefined,
  project: ResolveConversationFileSpaceInput["project"],
  input: ResolveConversationFileSpaceInput
): FileSpaceMount[] {
  const mounts: FileSpaceMount[] = []
  const leases = (context?.execution?.roots ?? []).filter((lease) => lease.aliasPath?.trim())
  const primaryLease = leases.find((lease) => lease.role === "primary") ?? leases[0]
  const projectPrimary = project ? primaryRootOf(project) : undefined
  const target = resolveExecutionRoot({ executionContext: context, project })

  // A managed workspace that is not on this device still IS this
  // conversation's workspace; listing it with its reason beats an empty panel
  // that reads as "this conversation has no files". Checked before the lease
  // path, which can still name the directory on the device that has it.
  const unavailable = managedUnavailability(context)
  if (unavailable) {
    mounts.push({
      id: "workspace",
      virtualPath: WORKSPACE_MOUNT_PATH,
      backing: "disk",
      label: rootLabel(project, primaryLease?.logicalRootId, undefined),
      managed: true,
      role: "primary",
      ...(primaryLease ? { logicalRootId: primaryLease.logicalRootId } : {}),
      writable: false,
      status: unavailable.status,
      statusReason: unavailable.reason,
    })
  } else if (target.root) {
    const primaryRootId =
      target.source === "execution" ? primaryLease?.logicalRootId : projectPrimary?.id
    mounts.push(
      diskMount(input, {
        id: "workspace",
        virtualPath: WORKSPACE_MOUNT_PATH,
        hostPath: target.root,
        managed: target.managed || isManagedLease(target.root, primaryRootId, project, context),
        role: "primary",
        logicalRootId: primaryRootId,
        label: rootLabel(project, primaryRootId, target.root),
      })
    )
  }

  const coveredRootIds = new Set<string>()
  if (primaryLease) coveredRootIds.add(primaryLease.logicalRootId)
  if (target.source === "workspace" && projectPrimary) coveredRootIds.add(projectPrimary.id)

  for (const lease of leases) {
    if (lease === primaryLease || lease.role !== "additional") continue
    if (coveredRootIds.has(lease.logicalRootId)) continue
    coveredRootIds.add(lease.logicalRootId)
    mounts.push(
      diskMount(input, {
        id: `root:${lease.logicalRootId}`,
        virtualPath: `${ROOTS_MOUNT_PREFIX}/${segmentFor(lease.logicalRootId)}`,
        hostPath: lease.aliasPath,
        managed: isManagedLease(lease.aliasPath, lease.logicalRootId, project, context),
        role: "additional",
        logicalRootId: lease.logicalRootId,
        label: rootLabel(project, lease.logicalRootId, lease.aliasPath),
      })
    )
  }

  for (const root of project?.roots ?? []) {
    if (root === projectPrimary || coveredRootIds.has(root.id) || !root.path.trim()) continue
    // The primary lease may name the project primary by a different logical id
    // ("primary" on fresh contexts); never list the primary root twice.
    if (projectPrimary && root.path === projectPrimary.path) continue
    coveredRootIds.add(root.id)
    mounts.push(
      diskMount(input, {
        id: `root:${root.id}`,
        virtualPath: `${ROOTS_MOUNT_PREFIX}/${segmentFor(root.id)}`,
        hostPath: root.path,
        managed: false,
        role: "additional",
        logicalRootId: root.id,
        label: root.label?.trim() || basename(root.path),
      })
    )
  }
  return mounts
}

interface DiskMountSpec {
  id: FileSpaceMount["id"]
  virtualPath: string
  hostPath: string
  managed: boolean
  role: "primary" | "additional"
  logicalRootId?: string
  label: string
}

function diskMount(input: ResolveConversationFileSpaceInput, spec: DiskMountSpec): FileSpaceMount {
  const containerPath = input.dockerSandbox
    ? containerPathFor(input.dockerSandbox, spec.hostPath)
    : null
  const { status, reason } = hostStatus(input.host)
  return {
    id: spec.id,
    virtualPath: spec.virtualPath,
    backing: "disk",
    label: spec.label,
    hostPath: spec.hostPath,
    ...(containerPath ? { containerPath } : {}),
    managed: spec.managed,
    role: spec.role,
    ...(spec.logicalRootId ? { logicalRootId: spec.logicalRootId } : {}),
    writable: status === "available",
    status,
    ...(reason ? { statusReason: reason } : {}),
  }
}

function hostStatus(host: FileSpaceHostState): {
  status: FileSpaceMountStatus
  reason?: FileSpaceMountStatusReason
} {
  if (!host.fsBackend) return { status: "offline", reason: "no-fs-backend" }
  if (!host.reachable) return { status: "offline", reason: "host-offline" }
  return { status: "available" }
}

function managedUnavailability(
  context: SessionExecutionContext | undefined
): { status: FileSpaceMountStatus; reason: FileSpaceMountStatusReason } | null {
  if (context?.workspaceBinding?.kind !== "managed") return null
  const availability = context.managedWorkspace?.availability
  if (availability === "missing-on-device") {
    return { status: "missing", reason: "managed-missing-on-device" }
  }
  if (availability === "deleted") return { status: "deleted", reason: "managed-deleted" }
  return null
}

/**
 * A lease is managed when its directory is not the workspace root it stands
 * for — a worktree or shadow — or when the conversation has no workspace root
 * for it at all (a managed workspace is app-owned by definition).
 */
function isManagedLease(
  hostPath: string,
  logicalRootId: string | undefined,
  project: ResolveConversationFileSpaceInput["project"],
  context: SessionExecutionContext | undefined
): boolean {
  if (context?.workspaceBinding?.kind === "managed") return true
  if (!project) return false
  const root =
    (logicalRootId
      ? project.roots.find((candidate) => candidate.id === logicalRootId)
      : undefined) ??
    (logicalRootId === undefined || logicalRootId === "primary"
      ? primaryRootOf(project)
      : undefined)
  if (!root) return context?.execution?.mode === "managed"
  return trimSlashes(root.path) !== trimSlashes(hostPath)
}

function rootLabel(
  project: ResolveConversationFileSpaceInput["project"],
  logicalRootId: string | undefined,
  hostPath: string | undefined
): string {
  const root =
    project && logicalRootId
      ? project.roots.find((candidate) => candidate.id === logicalRootId)
      : undefined
  const fallback = project ? primaryRootOf(project) : undefined
  const source =
    root ?? (logicalRootId === undefined || logicalRootId === "primary" ? fallback : undefined)
  if (source) return source.label?.trim() || basename(source.path)
  return hostPath ? basename(hostPath) : "workspace"
}

function dexieMounts(input: ResolveConversationFileSpaceInput): FileSpaceMount[] {
  const mounts: FileSpaceMount[] = []
  if (input.hasUploads) {
    mounts.push({
      id: "uploads",
      virtualPath: UPLOADS_MOUNT_PATH,
      backing: "dexie",
      // Dexie mounts are named by the UI from their id (`filespace.mount.*`).
      label: "uploads",
      managed: false,
      writable: false,
      status: "available",
    })
  }
  if (input.hasArtifacts) {
    mounts.push({
      id: "artifacts",
      virtualPath: ARTIFACTS_MOUNT_PATH,
      backing: "dexie",
      label: "artifacts",
      managed: false,
      writable: false,
      status: "available",
    })
  }
  return mounts
}

/**
 * A root id as one path segment. Root ids are `root-<nanoid>` or lease ids
 * minted by the host, which never contain `/`; anything that would break the
 * path grammar is percent-encoded rather than trusted.
 */
function segmentFor(id: string): string {
  if (/^[A-Za-z0-9._~-]+$/.test(id) && id !== "." && id !== "..") return id
  return encodeURIComponent(id).replace(/\./g, "%2E")
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function basename(path: string): string {
  const parts = trimSlashes(path).split("/").filter(Boolean)
  return parts.at(-1) ?? path
}
