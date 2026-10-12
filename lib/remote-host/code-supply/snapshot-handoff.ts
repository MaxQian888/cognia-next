/**
 * Continue a conversation on the always-on host, with its code (ADR-0224 A11b).
 *
 * The thread handoff (ADR-0103) already moves a conversation to another host
 * and leaves one writable copy. What it never moved was the working copy the
 * conversation was editing, so the continued session started on whatever the
 * host happened to have. This hands the code over first, then the
 * conversation, bound to it:
 *
 * 1. One admin lease from the host's owner covers every step below, the
 *    handoff's own accept and commit included, so the user is asked once.
 * 2. The workspace goes along as a copy (`project_mutate`), with or without a
 *    repository: the continued session must be able to belong to it.
 * 3. A snapshot of the session's working directory (`code_snapshot_create`):
 *    a binary patch against a commit the remote has when the workspace records
 *    an https repository, else a tar of its files. Capped at what the host
 *    accepts (`code_snapshot_limits_get`).
 * 4. A chunked upload into the host's staging area, each chunk hashed, the
 *    whole checked again at commit.
 * 5. `code_snapshot_apply`: the host makes a fresh checkout and refuses one
 *    that does not rebuild the desktop's tree.
 * 6. The thread handoff, naming the checkout. The host binds the continued
 *    session to it by id; no path crosses.
 *
 * A failure before step 6 leaves the conversation here, unfrozen; the staged
 * snapshot is cancelled on the host and the local one is always removed.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import {
  CODE_SNAPSHOT_HOST_OPERATIONS,
  CODE_SUPPLY_HOST_OPERATIONS,
  supportsHostFeatureOperation,
} from "@/lib/platform/host-feature-manifest"
import type {
  CodeCheckout,
  CodeSnapshotKind,
  CodeSnapshotLimits,
  CodeSnapshotUpload,
  CommittedCodeSnapshot,
  CreatedCodeSnapshot,
  TransferChunk,
} from "@/lib/task-workspace/types"
import { handoffProject } from "@/lib/workspace/project-transfer"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"
import type { Project } from "@/types"

/** Every operation the one lease must cover. */
export const SNAPSHOT_HANDOFF_LEASE_OPERATIONS: readonly string[] = Object.freeze([
  ...CODE_SUPPLY_HOST_OPERATIONS,
  ...CODE_SNAPSHOT_HOST_OPERATIONS,
  "thread_handoff_accept",
  "thread_handoff_commit",
])

/** Long enough for a large upload over the relay, short enough to expire unused. */
export const SNAPSHOT_HANDOFF_LEASE_TTL_SECONDS = 30 * 60

export type ContinueOnHostStep =
  "approving" | "workspace" | "snapshot" | "upload" | "apply" | "conversation"

export interface ContinueOnHostProgress {
  step: ContinueOnHostStep
  /** During `upload`. */
  sentBytes?: number
  totalBytes?: number
}

/** Why a conversation cannot be continued on the host. */
export type ContinueOnHostRefusal =
  "not-desktop" | "no-host" | "host-unsupported" | "shared" | "archived" | "in-handoff"

export class ContinueOnHostError extends Error {
  constructor(
    readonly code:
      ContinueOnHostRefusal | "no-working-directory" | "integrity-failed" | "upload-stalled",
    message?: string
  ) {
    super(message ?? `continue_on_host_${code}`)
    this.name = "ContinueOnHostError"
  }
}

/** What went wrong, in terms the person can act on. */
export type ContinueOnHostFailure =
  | "consent"
  | "too-large"
  | "no-remote"
  | "base-unavailable"
  | "tree-mismatch"
  | "unsafe-archive"
  | "integrity"
  | "no-working-directory"
  | "other"

/**
 * Classify a failure from any step: the host and this device's Rust answer
 * with a stable `code_snapshot_*` prefix, the lease with
 * `HostConsentRequiredError`.
 */
export function continueOnHostFailure(error: unknown): ContinueOnHostFailure {
  if (error instanceof Error && error.name === "HostConsentRequiredError") return "consent"
  if (error instanceof ContinueOnHostError) {
    if (error.code === "no-working-directory") return "no-working-directory"
    if (error.code === "integrity-failed" || error.code === "upload-stalled") return "integrity"
  }
  const message = error instanceof Error ? error.message : String(error)
  const rules: Array<[RegExp, ContinueOnHostFailure]> = [
    [/code_snapshot_too_large/, "too-large"],
    [/code_snapshot_no_remote|project_source_unavailable|project_remote_refused/, "no-remote"],
    [/code_snapshot_base_unavailable/, "base-unavailable"],
    [/code_snapshot_tree_mismatch|code_snapshot_apply_failed/, "tree-mismatch"],
    [/code_snapshot_unsafe_archive/, "unsafe-archive"],
    [/code_snapshot_integrity_failed|upload chunk hash mismatch/, "integrity"],
  ]
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "other"
}

type SessionFacts = Pick<ChatSession, "collaboration" | "archivedAt" | "handoffLock">

/** Whether `session` can be continued on `host`, and if not, why. */
export function continueOnHostRefusal(input: {
  session: SessionFacts
  host: Pick<RemoteHost, "featureManifest"> | null
  isDesktop: boolean
}): ContinueOnHostRefusal | null {
  if (!input.isDesktop) return "not-desktop"
  if (!input.host) return "no-host"
  if (input.session.collaboration) return "shared"
  if (input.session.archivedAt) return "archived"
  if (input.session.handoffLock) return "in-handoff"
  const supported = [...CODE_SUPPLY_HOST_OPERATIONS, ...CODE_SNAPSHOT_HOST_OPERATIONS].every(
    (operation) =>
      supportsHostFeatureOperation(input.host?.featureManifest, "always-on.code-supply", operation)
  )
  const handoff = ["thread_handoff_accept", "thread_handoff_commit"].every((operation) =>
    supportsHostFeatureOperation(input.host?.featureManifest, "session.thread-handoff", operation)
  )
  return supported && handoff ? null : "host-unsupported"
}

/**
 * The snapshot form for a workspace: a patch only when the host can fetch the
 * base, which needs the https repository the workspace records.
 */
export function snapshotKindFor(
  project: Pick<Project, "repository"> | null | undefined
): CodeSnapshotKind | undefined {
  return project?.repository?.remoteUrl ? undefined : "tar"
}

interface Caller {
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>
}

export interface SnapshotHandoffDeps {
  workingDirectory(sessionId: string): Promise<string | undefined>
  project(projectId: string): Promise<Project | undefined>
  openTarget(hostRef: string): Promise<{ transport: Caller; close(): void }>
  issueLease(operations: string[], ttlSeconds: number, target: Caller): Promise<{ token: string }>
  createSnapshot(input: {
    root: string
    maxBytes?: number
    kind?: CodeSnapshotKind
  }): Promise<CreatedCodeSnapshot>
  readChunk(snapshotId: string, offset: number): Promise<TransferChunk>
  discardSnapshot(snapshotId: string): Promise<void>
  startHandoff(
    session: ChatSession,
    target: { hostRef: string; kind: "desktop"; label?: string },
    options: { codeCheckout: { checkoutId: string }; adminLease: string }
  ): Promise<ThreadHandoffTicket>
}

export interface ContinueOnHostResult {
  ticket: ThreadHandoffTicket
  checkout: CodeCheckout
}

/** Continue `session` on `host` with its code. Run only from an explicit user action. */
export async function continueSessionOnAlwaysOnHost(
  session: ChatSession,
  host: Pick<RemoteHost, "id" | "label" | "featureManifest">,
  options: { onProgress?: (progress: ContinueOnHostProgress) => void } = {},
  deps: SnapshotHandoffDeps = defaultSnapshotHandoffDeps()
): Promise<ContinueOnHostResult> {
  const refusal = continueOnHostRefusal({ session, host, isDesktop: true })
  if (refusal) throw new ContinueOnHostError(refusal)
  const progress = options.onProgress ?? (() => {})
  const root = await deps.workingDirectory(session.id)
  if (!root) throw new ContinueOnHostError("no-working-directory")
  const project = session.projectId ? await deps.project(session.projectId) : undefined

  const remote = await deps.openTarget(host.id)
  try {
    progress({ step: "approving" })
    const lease = await deps.issueLease(
      [...SNAPSHOT_HANDOFF_LEASE_OPERATIONS],
      SNAPSHOT_HANDOFF_LEASE_TTL_SECONDS,
      remote.transport
    )
    const adminLease = lease.token
    const limits = await remote.transport.call<CodeSnapshotLimits>("code_snapshot_limits_get", {})

    progress({ step: "snapshot" })
    const kind = snapshotKindFor(project)
    const created = await deps.createSnapshot({
      root,
      maxBytes: limits.maxBytes,
      ...(kind ? { kind } : {}),
    })
    let checkout: CodeCheckout
    try {
      const copy = project ? handoffProject(project) : null
      if (copy) {
        progress({ step: "workspace" })
        await remote.transport.call("project_mutate", {
          operation: "upsert",
          operationId: `handoff:${created.snapshotId}`,
          project: copy,
          adminLease,
        })
      }
      const committed = await upload(created, remote.transport, adminLease, deps, progress)
      progress({ step: "apply" })
      checkout = await remote.transport.call<CodeCheckout>("code_snapshot_apply", {
        input: {
          snapshotId: committed.snapshotId,
          manifest: created.manifest,
          projectId: copy?.id ?? null,
          roots: copy?.roots.map((entry) => entry.path) ?? [],
          remoteUrl: copy?.repository?.remoteUrl ?? null,
        },
        adminLease,
      })
    } finally {
      await deps.discardSnapshot(created.snapshotId).catch(() => {})
    }

    progress({ step: "conversation" })
    const ticket = await deps.startHandoff(
      session,
      { hostRef: host.id, kind: "desktop", ...(host.label ? { label: host.label } : {}) },
      { codeCheckout: { checkoutId: checkout.checkoutId }, adminLease }
    )
    return { ticket, checkout }
  } finally {
    remote.close()
  }
}

async function upload(
  created: CreatedCodeSnapshot,
  host: Caller,
  adminLease: string,
  deps: SnapshotHandoffDeps,
  progress: (progress: ContinueOnHostProgress) => void
): Promise<CommittedCodeSnapshot> {
  const total = created.manifest.sizeBytes
  const opened = await host.call<CodeSnapshotUpload>("code_snapshot_upload_open", {
    sizeBytes: total,
    sha256: created.manifest.sha256,
    adminLease,
  })
  try {
    let offset = 0
    progress({ step: "upload", sentBytes: 0, totalBytes: total })
    while (offset < total) {
      const chunk = await deps.readChunk(created.snapshotId, offset)
      if (chunk.nextOffset <= offset) throw new ContinueOnHostError("upload-stalled")
      const written = await host.call<number>("code_snapshot_upload_write_chunk", {
        uploadId: opened.uploadId,
        offset: chunk.offset,
        dataBase64: chunk.dataBase64,
        chunkHash: chunk.chunkHash,
        adminLease,
      })
      if (written !== chunk.nextOffset) throw new ContinueOnHostError("upload-stalled")
      offset = written
      progress({ step: "upload", sentBytes: offset, totalBytes: total })
    }
    const committed = await host.call<CommittedCodeSnapshot>("code_snapshot_upload_commit", {
      uploadId: opened.uploadId,
      adminLease,
    })
    if (committed.sha256 !== created.manifest.sha256 || committed.sizeBytes !== total) {
      throw new ContinueOnHostError("integrity-failed")
    }
    return committed
  } catch (error) {
    await host
      .call("code_snapshot_upload_cancel", { uploadId: opened.uploadId, adminLease })
      .catch(() => {})
    throw error
  }
}

export function defaultSnapshotHandoffDeps(): SnapshotHandoffDeps {
  return {
    workingDirectory: async (sessionId) => {
      const { resolveSessionCwd } = await import("@/lib/workspace/session-cwd")
      return resolveSessionCwd(sessionId)
    },
    project: async (projectId) => {
      const { getDb } = await import("@/lib/db/schema")
      return (await getDb().projects.get(projectId)) ?? undefined
    },
    openTarget: async (hostRef) => {
      const { openRemoteHostTarget } = await import("@/lib/remote-host/target-transport")
      return openRemoteHostTarget(hostRef)
    },
    issueLease: async (operations, ttlSeconds, target) => {
      const { issueHostAdminLease } = await import("@/lib/tauri/admin-lease")
      return issueHostAdminLease(operations, ttlSeconds, target)
    },
    createSnapshot: async (input) => {
      const { createCodeSnapshot } = await import("@/lib/task-workspace/client")
      return createCodeSnapshot(input)
    },
    readChunk: async (snapshotId, offset) => {
      const { readCodeSnapshotChunk } = await import("@/lib/task-workspace/client")
      return readCodeSnapshotChunk(snapshotId, offset)
    },
    discardSnapshot: async (snapshotId) => {
      const { discardCodeSnapshot } = await import("@/lib/task-workspace/client")
      return discardCodeSnapshot(snapshotId)
    },
    startHandoff: async (session, target, handoff) => {
      const { startRemoteThreadHandoff } = await import("@/lib/thread-handoff/orchestrator")
      return startRemoteThreadHandoff(session, target, Date.now(), handoff)
    },
  }
}
