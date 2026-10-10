/**
 * Keep the live file-share host in step with this app (ADR-0222 §7.5).
 *
 * The host (`crates/cognia-file-share`) serves grants from three things only
 * the app knows, and this module is where each comes from:
 *
 * - **The account.** `activate` serves the unlocked account's grants and
 *   nothing else; locking or switching stops every listener and connection.
 * - **The policy.** The effective file-sharing policy (the person's own,
 *   intersected with the org's) is pushed whenever it may have changed; the
 *   host stamps a revision and re-checks every grant against it.
 * - **The mount tables.** What each conversation's FileSpace resolves to:
 *   which directories `/workspace` and `/roots/*` are, and which uploads and
 *   artifacts are listed. They are pushed for the conversations that have
 *   grants when the service activates, and the host pulls them itself
 *   whenever it needs one fresh (`companion://filespace-mounts-request`,
 *   answered from `./mount-table.ts`): on every grant creation, on a resume,
 *   and once a minute for every conversation with a grant.
 *
 * The same code runs in the desktop WebView (against this machine's host) and
 * in the headless brain (against its own server). In both cases the host
 * asking is the one the files live on, so a FileSpace is resolved here as
 * this host sees it.
 */

import {
  activateFileShare,
  getFileShareStatus,
  pushFileSharingPolicy,
  syncFileSpaces,
  type FileShareTarget,
} from "@/lib/filespace/grants-client"
import {
  loadEffectiveFileSharingPolicy,
  type EffectiveFileSharingPolicy,
} from "@/lib/filespace/policy"
import { buildSessionMountsInput, type MountTableDeps } from "@/lib/filespace/mount-table"
import type { FileShareStatus, SessionMountsInput } from "@/types/filespace/live"

/** How often the controller re-reads the host (and re-pushes the policy). */
export const HOST_SYNC_INTERVAL_MS = 60_000

export interface FileShareHostSyncDeps extends MountTableDeps {
  /** Which host to talk to: this machine's on the desktop, the brain's own server. */
  target: FileShareTarget
  /** The unlocked local account, or null while locked. */
  accountId: () => string | null
  loadPolicy: () => Promise<EffectiveFileSharingPolicy>
  log?: (level: "info" | "warn", message: string) => void
}

export interface FileShareHostSync {
  /** Serve the current account (or nothing), then push policy and mounts. */
  activate(): Promise<FileShareStatus | null>
  /** Push the effective policy. */
  pushPolicy(): Promise<void>
  /** Push these conversations' mount tables. */
  syncSessions(sessionIds: readonly string[]): Promise<void>
  /** Re-read the host and push what it serves from. */
  refresh(): Promise<void>
  /** Activate now and refresh on an interval; returns the stop function. */
  start(options?: { intervalMs?: number }): () => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createFileShareHostSync(deps: FileShareHostSyncDeps): FileShareHostSync {
  const log = deps.log ?? (() => {})
  // One call at a time: an activation racing a refresh could push the
  // previous account's tables into the next account's store.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  const pushPolicy = async () => {
    const effective = await deps.loadPolicy()
    await pushFileSharingPolicy(
      {
        policy: effective.policy,
        ...(effective.org
          ? { orgId: effective.org.orgId, orgRevision: effective.org.policy.revision }
          : {}),
      },
      deps.target
    )
  }

  const syncSessions = async (sessionIds: readonly string[]) => {
    if (sessionIds.length === 0) return
    const sessions: SessionMountsInput[] = []
    for (const sessionId of sessionIds) {
      try {
        sessions.push(await buildSessionMountsInput(sessionId, deps))
      } catch (error) {
        log("warn", `file share: mount table for ${sessionId} not built: ${describe(error)}`)
      }
    }
    if (sessions.length > 0) await syncFileSpaces(sessions, deps.target)
  }

  const activate = async () => {
    const accountId = deps.accountId()
    const status = await activateFileShare(accountId, deps.target)
    if (!accountId) return status
    await pushPolicy()
    await syncSessions(status.sessionsWithGrants)
    return status
  }

  const refresh = async () => {
    if (!deps.accountId()) return
    const status = await getFileShareStatus(deps.target)
    if (!status.active || status.accountId !== deps.accountId()) {
      // The host restarted or lost the account: serve it again.
      await activate()
      return
    }
    await pushPolicy()
    await syncSessions(status.sessionsWithGrants)
  }

  const guarded =
    <T>(name: string, task: () => Promise<T>) =>
    () =>
      serial(task).catch((error) => {
        log("warn", `file share: ${name} failed: ${describe(error)}`)
        return null
      })

  return {
    activate: () => serial(activate),
    pushPolicy: () => serial(pushPolicy),
    syncSessions: (ids) => serial(() => syncSessions(ids)),
    refresh: () => serial(refresh),
    start: ({ intervalMs = HOST_SYNC_INTERVAL_MS } = {}) => {
      void guarded("activation", activate)()
      const timer = setInterval(() => void guarded("refresh", refresh)(), intervalMs)
      return () => clearInterval(timer)
    },
  }
}

/** The policy loader the controllers use by default. */
export const defaultLoadPolicy = (): Promise<EffectiveFileSharingPolicy> =>
  loadEffectiveFileSharingPolicy()
