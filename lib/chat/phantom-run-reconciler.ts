/**
 * Phantom-run reconciliation: a session must never present as running when
 * nothing is running it.
 *
 * The chat store is in-memory and never persisted, so a session that reads
 * `streaming` / `awaiting_approval` after a relaunch was put there by
 * something AFTER boot — a projection of remote state, a replayed frame, a
 * resumed side effect — not by a turn this renderer started. Seen on the
 * Capacitor client paired to a headless Host: an external-agent turn failed
 * with `Request timeout: session/prompt`, the Host restarted (so it no longer
 * had the run) and the app relaunched; the conversation came back `streaming`
 * with the run strip's clock counting from launch, Stop instead of Send, and
 * the turn's last tool rows still "running".
 *
 * The guard here does not need to know which path produced the status. Every
 * time a session ENTERS a busy state it waits a short grace, then asks:
 *
 *  1. Is there a live run handle in this realm? A local send holds an
 *     execution-broker lease (acquired before the `streaming` flip) or is
 *     queued for one; a direct-chat turn has an open execution run; a paired
 *     client projecting a room's members has them in flight; an approval
 *     still pending in the slice has its resolver in memory. Any of these
 *     means the turn is real — left alone.
 *  2. Does a Host own this session's turn? For a HostState-replicated
 *     conversation the Host's confirmed turn (plus this device's still-pending
 *     sends) is the answer: a live Host turn stays running, and the HostState
 *     stream keeps driving it — that IS the reattach. A settled one is gone.
 *  3. Otherwise nothing can be running it — a remote external-agent run that
 *     was not started from this realm cannot be re-subscribed after a reload
 *     (its frames are addressed to a run id only the old renderer knew), and
 *     its Host ends an abandoned run when the client disconnects.
 *
 * Gone or unknown settles the session: open tool parts are closed as
 * interrupted (in the slice and, as a partial write, in Dexie), live
 * approvals are marked interrupted, and the status goes idle — which also
 * clears the run clock, so a phantom never shows an elapsed time.
 */

import type { UIMessage } from "ai"

import { closeOpenToolParts, hasOpenToolParts } from "@/lib/chat/phantom-run"
import type { ChatStatus } from "@/stores/chat/chat-store"

export type RunLiveness = "alive" | "gone" | "unknown"

export interface PhantomRunDeps {
  /** True while a turn this realm started for `sessionId` is still running. */
  hasLocalRunHandle: (sessionId: string) => boolean
  /**
   * Whether a Host reports this session's turn alive. `null` when no Host owns
   * the session's turn state (the answer is then "unknown").
   */
  probeHostRun: (sessionId: string) => Promise<RunLiveness | null>
  /** Persist the given messages as a partial transcript write (never a full replace). */
  commitMessages: (sessionId: string, upserts: UIMessage[]) => Promise<void>
}

/** The slice of the chat store this module reads and writes. */
export interface PhantomRunStore {
  getState: () => {
    sessions: Record<
      string,
      | {
          status: ChatStatus
          messages: UIMessage[]
          runTiming?: { startedAt: number | null }
          pendingApprovals: ReadonlyArray<{
            requestId: string
            sessionId: string
            status?: string
          }>
        }
      | undefined
    >
    replaceSessionMessages: (id: string, msgs: UIMessage[]) => void
    markApprovalInterrupted: (requestId: string, sessionId?: string, reason?: string) => void
    setSessionStatus: (id: string, s: ChatStatus) => void
  }
  subscribe: (listener: () => void) => () => void
}

export type ReconcileOutcome = "not-busy" | "live" | "settled"

/** Reason stamped on approvals a phantom run held. */
export const PHANTOM_RUN_APPROVAL_REASON = "run no longer active"

function isBusy(status: ChatStatus | undefined): boolean {
  return status === "streaming" || status === "awaiting_approval"
}

function hasLiveApproval(approvals: ReadonlyArray<{ status?: string }> | undefined): boolean {
  return (approvals ?? []).some((approval) => approval.status !== "interrupted")
}

/**
 * Decide one session, and settle it when nothing is running it.
 *
 * `episodeStartedAt` pins the busy episode the caller observed: when the
 * session has since settled and started a NEW turn, that turn is left for its
 * own check rather than judged on this one's evidence.
 */
export async function reconcileSessionRun(
  sessionId: string,
  deps: PhantomRunDeps,
  store: PhantomRunStore,
  episodeStartedAt?: number | null
): Promise<ReconcileOutcome> {
  const sameEpisode = (): boolean => {
    const slice = store.getState().sessions[sessionId]
    if (!slice || !isBusy(slice.status)) return false
    return (
      episodeStartedAt === undefined || (slice.runTiming?.startedAt ?? null) === episodeStartedAt
    )
  }
  const locallyLive = (): boolean => {
    const slice = store.getState().sessions[sessionId]
    return deps.hasLocalRunHandle(sessionId) || hasLiveApproval(slice?.pendingApprovals)
  }

  if (!sameEpisode()) return "not-busy"
  if (locallyLive()) return "live"

  let host: RunLiveness | null
  try {
    host = await deps.probeHostRun(sessionId)
  } catch {
    host = "unknown"
  }
  if (host === "alive") return "live"

  // The probe awaited: the turn may have settled, restarted, or acquired a
  // handle in the meantime. Only the episode we judged is settled.
  if (!sameEpisode()) return "not-busy"
  if (locallyLive()) return "live"

  const state = store.getState()
  const slice = state.sessions[sessionId]!
  if (hasOpenToolParts(slice.messages)) {
    const { messages, changed } = closeOpenToolParts(slice.messages)
    state.replaceSessionMessages(sessionId, messages)
    await deps.commitMessages(sessionId, changed).catch((error: unknown) => {
      console.warn("phantom run: closing open tool parts failed to persist", error)
    })
  }
  const current = store.getState()
  for (const approval of current.sessions[sessionId]?.pendingApprovals ?? []) {
    if (approval.status === "interrupted") continue
    current.markApprovalInterrupted(
      approval.requestId,
      approval.sessionId,
      PHANTOM_RUN_APPROVAL_REASON
    )
  }
  // Last, so the approval bookkeeping above cannot flip it back to streaming.
  store.getState().setSessionStatus(sessionId, "idle")
  return "settled"
}

export interface PhantomRunGuardOptions {
  deps: PhantomRunDeps
  store: PhantomRunStore
  /**
   * How long a session must have been busy before it is checked. Covers the
   * handful of ticks a legitimate run may take between its status flip and
   * the evidence the checks read (a HostState snapshot landing, a send's
   * outbox row committing).
   */
  graceMs?: number
}

/** Default grace before a newly busy session is checked. */
export const PHANTOM_RUN_GRACE_MS = 3_000

/**
 * Watch the chat store and reconcile every session that becomes busy.
 * Sessions already busy at install are checked too. Returns the uninstaller.
 */
export function installPhantomRunGuard(options: PhantomRunGuardOptions): () => void {
  const { deps, store } = options
  const graceMs = options.graceMs ?? PHANTOM_RUN_GRACE_MS
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const seen = new Map<string, number | null>()
  let disposed = false

  const schedule = (sessionId: string, episodeStartedAt: number | null) => {
    const existing = timers.get(sessionId)
    if (existing) clearTimeout(existing)
    timers.set(
      sessionId,
      setTimeout(() => {
        timers.delete(sessionId)
        if (disposed) return
        void reconcileSessionRun(sessionId, deps, store, episodeStartedAt).catch((error: unknown) =>
          console.warn("phantom run reconciliation failed", error)
        )
      }, graceMs)
    )
  }

  const scan = () => {
    const sessions = store.getState().sessions
    for (const [sessionId, slice] of Object.entries(sessions)) {
      if (!slice || !isBusy(slice.status)) {
        if (seen.has(sessionId)) seen.delete(sessionId)
        continue
      }
      const startedAt = slice.runTiming?.startedAt ?? null
      // One check per busy episode: an approval pause and resume keep the
      // turn's clock, so they are not new episodes.
      if (seen.has(sessionId) && seen.get(sessionId) === startedAt) continue
      seen.set(sessionId, startedAt)
      schedule(sessionId, startedAt)
    }
    for (const sessionId of [...seen.keys()]) {
      if (!sessions[sessionId]) seen.delete(sessionId)
    }
  }

  const unsubscribe = store.subscribe(scan)
  scan()

  return () => {
    disposed = true
    unsubscribe()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    seen.clear()
  }
}
