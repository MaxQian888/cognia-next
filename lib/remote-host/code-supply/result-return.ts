/**
 * Bring a conversation's work back from the always-on host (ADR-0224 A11c).
 *
 * A conversation continued on the host with its code (A11b) works in a
 * checkout there. Its desktop copy is read-only from then on, and this is how
 * what the agent did gets back to the person, with one action:
 *
 * 1. One admin lease from the host's owner covers the export and the reads.
 * 2. `code_checkout_export`: the host commits anything left uncommitted (on
 *    top of the agent's own commits, without moving its branch) and pushes
 *    the tip as `cognia/<agent>-<id>` with its stored git credential. When it
 *    cannot push, the same commits are staged as a git bundle, or the files
 *    as a tar for a folder without git.
 * 3. A staged bundle or tar is read out chunk by chunk into this device's
 *    staging area, each chunk hashed and the whole checked at commit.
 * 4. `code_result_apply` checks the commits out into a NEW worktree on a new
 *    local branch (a tar into a new folder). The folder the conversation
 *    started from is never touched. Asking again answers with the same
 *    worktree while nothing changed on the host.
 *
 * Then, when the repository is on GitHub and a credential is connected, a
 * draft pull request can be opened from that branch.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { ThreadHandoffTicket } from "@cognia/agent-config-types/thread-handoff"
import {
  CODE_RESULT_HOST_OPERATIONS,
  supportsHostFeatureOperation,
} from "@/lib/platform/host-feature-manifest"
import type { HumanGithubWrite } from "@/lib/policy/action-review/human-github-write"
import { repositoryOnHost } from "@/lib/policy/action-review/outbound-targets"
import type {
  AppliedCodeResult,
  CodeResult,
  CodeResultTransfer,
  CodeSnapshotUpload,
  CommittedCodeSnapshot,
  TransferChunk,
} from "@/lib/task-workspace/types"
import type { RemoteHost } from "@/stores/remote-host/remote-host-store"
import type { CreatePullRequestInput, PullRequestProvider, PullRequestRef } from "@/types/review"

/** Every operation the one lease must cover. */
export const RESULT_RETURN_LEASE_OPERATIONS: readonly string[] = Object.freeze([
  ...CODE_RESULT_HOST_OPERATIONS,
])

/** Long enough for a large download over the relay, short enough to expire unused. */
export const RESULT_RETURN_LEASE_TTL_SECONDS = 30 * 60

/** The agent name a branch carries when the session names none. */
export const DEFAULT_RESULT_AGENT = "cognia"

export type BringBackStep = "approving" | "export" | "download" | "apply"

export interface BringBackProgress {
  step: BringBackStep
  /** During `download`. */
  receivedBytes?: number
  totalBytes?: number
}

/** A conversation whose code went to an always-on host, as its source sees it. */
export interface HandedOverCode {
  ticketId: string
  hostRef: string
  hostLabel?: string
  checkoutId: string
}

/** Why the work cannot be brought back. */
export type BringBackRefusal = "not-desktop" | "no-code" | "host-unsupported"

export class BringBackError extends Error {
  constructor(
    readonly code:
      BringBackRefusal | "no-working-directory" | "integrity-failed" | "download-stalled",
    message?: string
  ) {
    super(message ?? `bring_back_${code}`)
    this.name = "BringBackError"
  }
}

/** What went wrong, in terms the person can act on. */
export type BringBackFailure =
  | "consent"
  | "unchanged"
  | "checkout-gone"
  | "fetch-failed"
  | "mismatch"
  | "not-git"
  | "too-large"
  | "integrity"
  | "no-working-directory"
  | "other"

/**
 * Classify a failure from any step: the host and this device's Rust answer
 * with a stable `code_result_*` (or `code_snapshot_*`) prefix, the lease with
 * `HostConsentRequiredError`.
 */
export function bringBackFailure(error: unknown): BringBackFailure {
  if (error instanceof Error && error.name === "HostConsentRequiredError") return "consent"
  if (error instanceof BringBackError) {
    if (error.code === "no-working-directory") return "no-working-directory"
    if (error.code === "integrity-failed" || error.code === "download-stalled") return "integrity"
  }
  const message = error instanceof Error ? error.message : String(error)
  const rules: Array<[RegExp, BringBackFailure]> = [
    [/code_result_unchanged/, "unchanged"],
    [/code_result_not_found|code_result_unavailable/, "checkout-gone"],
    [/code_result_fetch_failed|code_result_base_missing/, "fetch-failed"],
    [/code_result_mismatch/, "mismatch"],
    [/code_result_not_git/, "not-git"],
    [/code_snapshot_too_large/, "too-large"],
    [/code_snapshot_integrity_failed|upload chunk hash mismatch/, "integrity"],
  ]
  return rules.find(([pattern]) => pattern.test(message))?.[1] ?? "other"
}

/**
 * The handed-over code of a session whose handoff is committed, read from its
 * own source ticket. `null` for any other session.
 */
export function handedOverCode(
  session: Pick<ChatSession, "handoffLock">,
  ticket: ThreadHandoffTicket | undefined
): HandedOverCode | null {
  const lock = session.handoffLock
  if (!lock || lock.state !== "committed" || !ticket) return null
  if (ticket.ticketId !== lock.ticketId || ticket.role !== "source") return null
  const checkoutId = ticket.project.codeCheckout?.checkoutId
  if (!checkoutId) return null
  return {
    ticketId: ticket.ticketId,
    hostRef: ticket.target.hostRef,
    ...(ticket.target.label ? { hostLabel: ticket.target.label } : {}),
    checkoutId,
  }
}

/** Whether the work can be brought back from `host`, and if not, why. */
export function bringBackRefusal(input: {
  handed: HandedOverCode | null
  host: Pick<RemoteHost, "featureManifest"> | null
  isDesktop: boolean
}): BringBackRefusal | null {
  if (!input.isDesktop) return "not-desktop"
  if (!input.handed) return "no-code"
  const supported = CODE_RESULT_HOST_OPERATIONS.every((operation) =>
    supportsHostFeatureOperation(input.host?.featureManifest, "always-on.code-supply", operation)
  )
  return supported ? null : "host-unsupported"
}

/**
 * The `<agent>` of the branch: the external agent the session ran, as
 * lowercase letters, digits and dashes (what the host accepts), else
 * {@link DEFAULT_RESULT_AGENT}.
 */
export function codeResultAgent(session: Pick<ChatSession, "externalAgentSession">): string {
  const slug = (session.externalAgentSession?.agentId ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "")
  return slug || DEFAULT_RESULT_AGENT
}

interface Caller {
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>
}

export interface BringBackDeps {
  workingDirectory(sessionId: string): Promise<string | undefined>
  openTarget(hostRef: string): Promise<{ transport: Caller; close(): void }>
  issueLease(operations: string[], ttlSeconds: number, target: Caller): Promise<{ token: string }>
  receiveOpen(sizeBytes: number, sha256: string): Promise<CodeSnapshotUpload>
  receiveWrite(input: {
    uploadId: string
    offset: number
    dataBase64: string
    chunkHash: string
  }): Promise<number>
  receiveCommit(uploadId: string): Promise<CommittedCodeSnapshot>
  receiveCancel(uploadId: string): Promise<void>
  apply(input: {
    root: string
    result: CodeResult
    receivedId?: string | null
  }): Promise<AppliedCodeResult>
}

export interface BringBackResult {
  result: CodeResult
  applied: AppliedCodeResult
}

/** Bring `session`'s work back from the host. Run only from an explicit user action. */
export async function bringChangesBack(
  session: Pick<ChatSession, "id" | "externalAgentSession">,
  handed: HandedOverCode | null,
  host: Pick<RemoteHost, "featureManifest"> | null,
  options: { onProgress?: (progress: BringBackProgress) => void } = {},
  deps: BringBackDeps = defaultBringBackDeps()
): Promise<BringBackResult> {
  const refusal = bringBackRefusal({ handed, host, isDesktop: true })
  if (refusal || !handed) throw new BringBackError(refusal ?? "no-code")
  const progress = options.onProgress ?? (() => {})
  const root = await deps.workingDirectory(session.id)
  if (!root) throw new BringBackError("no-working-directory")

  const remote = await deps.openTarget(handed.hostRef)
  try {
    progress({ step: "approving" })
    const lease = await deps.issueLease(
      [...RESULT_RETURN_LEASE_OPERATIONS],
      RESULT_RETURN_LEASE_TTL_SECONDS,
      remote.transport
    )
    const adminLease = lease.token

    progress({ step: "export" })
    const result = await remote.transport.call<CodeResult>("code_checkout_export", {
      input: { checkoutId: handed.checkoutId, agent: codeResultAgent(session) },
      adminLease,
    })

    let receivedId: string | null = null
    if (result.transfer) {
      const transfer = result.transfer
      try {
        receivedId = await download(transfer, remote.transport, adminLease, deps, progress)
      } finally {
        await remote.transport
          .call("code_result_discard", { resultId: transfer.resultId, adminLease })
          .catch(() => {})
      }
    }

    progress({ step: "apply" })
    const applied = await deps.apply({ root, result, receivedId })
    return { result, applied }
  } finally {
    remote.close()
  }
}

async function download(
  transfer: CodeResultTransfer,
  host: Caller,
  adminLease: string,
  deps: BringBackDeps,
  progress: (progress: BringBackProgress) => void
): Promise<string> {
  const total = transfer.manifest.sizeBytes
  const opened = await deps.receiveOpen(total, transfer.manifest.sha256)
  try {
    let offset = 0
    progress({ step: "download", receivedBytes: 0, totalBytes: total })
    while (offset < total) {
      const chunk = await host.call<TransferChunk>("code_result_read_chunk", {
        resultId: transfer.resultId,
        offset,
        adminLease,
      })
      if (chunk.offset !== offset || chunk.nextOffset <= offset) {
        throw new BringBackError("download-stalled")
      }
      const written = await deps.receiveWrite({
        uploadId: opened.uploadId,
        offset: chunk.offset,
        dataBase64: chunk.dataBase64,
        chunkHash: chunk.chunkHash,
      })
      if (written !== chunk.nextOffset) throw new BringBackError("download-stalled")
      offset = written
      progress({ step: "download", receivedBytes: offset, totalBytes: total })
    }
    const committed = await deps.receiveCommit(opened.uploadId)
    if (committed.sha256 !== transfer.manifest.sha256 || committed.sizeBytes !== total) {
      throw new BringBackError("integrity-failed")
    }
    return committed.snapshotId
  } catch (error) {
    await deps.receiveCancel(opened.uploadId).catch(() => {})
    throw error
  }
}

type ResultPullRequestProvider = Pick<
  PullRequestProvider,
  "getAuthenticationState" | "findForBranch" | "push" | "create"
>

/**
 * Whether a pull request can be opened for work that came back: git work with
 * a base branch to target, in a repository the provider can act on.
 */
export async function resultPullRequestAvailable(
  brought: BringBackResult,
  provider: ResultPullRequestProvider
): Promise<boolean> {
  if (brought.result.kind === "tar" || !brought.result.baseRef || !brought.applied.branch) {
    return false
  }
  try {
    return (await provider.getAuthenticationState(brought.applied.path)) === "authenticated"
  } catch {
    return false
  }
}

export interface ResultPullRequestDeps {
  /** The conversation the work came back for, to file the receipt under. */
  sessionId?: string
  /** The GitHub repository a checkout pushes to. */
  resolveRepository?: (
    workingDir: string
  ) => Promise<{ fullName: string; host?: { id: string } } | null>
  record?: (write: HumanGithubWrite) => Promise<void>
}

/**
 * Open (or find) a draft pull request for work that came back. A pushed
 * result already has its branch on the remote; a bundle's local branch is
 * pushed first, with the user's own git credentials.
 *
 * The person asked for it, so it records a human receipt for the repository
 * before the first write (ADR-0239 phase 2); a repository that cannot be
 * named is recorded as an unknown GitHub repository.
 */
export async function openResultPullRequest(
  brought: BringBackResult,
  text: { title: string; body: string },
  provider: ResultPullRequestProvider,
  deps: ResultPullRequestDeps = {}
): Promise<PullRequestRef> {
  const { result, applied } = brought
  const baseRef = result.baseRef
  const head = result.kind === "branch" ? result.branch : applied.branch
  if (result.kind === "tar" || !baseRef || !head || !applied.branch) {
    throw new Error("code_result_no_pull_request: this work has no branch to propose")
  }
  await recordResultPullRequest(applied.path, deps)
  if (result.kind === "bundle") await provider.push(applied.path, applied.branch)
  const existing = await provider.findForBranch(applied.path, head)
  if (existing) return existing
  const input: CreatePullRequestInput = {
    repositoryRoot: applied.path,
    headRef: head,
    baseRef,
    title: text.title,
    body: text.body,
    draft: true,
  }
  return provider.create(input)
}

async function recordResultPullRequest(root: string, deps: ResultPullRequestDeps): Promise<void> {
  const resolve =
    deps.resolveRepository ??
    (await import("@/lib/ai/agent/team/pr-feedback/resolvers")).createResolveTeamRepo()
  const repository = await resolve(root).catch(() => null)
  const record =
    deps.record ??
    (await import("@/lib/policy/action-review/human-github-write")).recordHumanGithubWrite
  await record({
    targets: [repository ? repositoryOnHost(repository.fullName, repository.host?.id) : undefined],
    operation: "github.openPr",
    surface: "handoff",
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
  })
}

export function defaultBringBackDeps(): BringBackDeps {
  return {
    workingDirectory: async (sessionId) => {
      const { resolveSessionCwd } = await import("@/lib/workspace/session-cwd")
      return resolveSessionCwd(sessionId)
    },
    openTarget: async (hostRef) => {
      const { openRemoteHostTarget } = await import("@/lib/remote-host/target-transport")
      return openRemoteHostTarget(hostRef)
    },
    issueLease: async (operations, ttlSeconds, target) => {
      const { issueHostAdminLease } = await import("@/lib/tauri/admin-lease")
      return issueHostAdminLease(operations, ttlSeconds, target)
    },
    receiveOpen: async (sizeBytes, sha256) => {
      const { openCodeResultReceive } = await import("@/lib/task-workspace/client")
      return openCodeResultReceive(sizeBytes, sha256)
    },
    receiveWrite: async (input) => {
      const { writeCodeResultChunk } = await import("@/lib/task-workspace/client")
      return writeCodeResultChunk(input)
    },
    receiveCommit: async (uploadId) => {
      const { commitCodeResultReceive } = await import("@/lib/task-workspace/client")
      return commitCodeResultReceive(uploadId)
    },
    receiveCancel: async (uploadId) => {
      const { cancelCodeResultReceive } = await import("@/lib/task-workspace/client")
      return cancelCodeResultReceive(uploadId)
    },
    apply: async (input) => {
      const { applyCodeResult } = await import("@/lib/task-workspace/client")
      return applyCodeResult(input)
    },
  }
}
