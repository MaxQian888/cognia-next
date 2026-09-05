/**
 * Watch one Squad run until it settles.
 *
 * A conversation that hands its turn to a Squad has to keep holding the
 * session — the same posture `use-team-chat.ts` takes for a multi-member turn.
 * Holding it is what makes a follow-up typed mid-run queue as steering instead
 * of starting a *second* Squad run over the top of the first. So something has
 * to notice when the run is over, and the Squad lifecycle is deliberately
 * fire-and-forget (a run can take minutes; no caller may await it).
 *
 * The execution run row is that signal: `settleAgentTeamExecutionRun` drives it
 * to a terminal status, so watching the row needs no new plumbing on the
 * runtime side. `paused` is NOT terminal — a paused Squad is still this
 * conversation's turn, and the user can steer it.
 *
 * Fires `onSettled` at most once and then disposes itself. The returned
 * function is safe to call afterwards.
 */

import Dexie from "dexie"

import { getDb } from "@/lib/db/schema"
import { getExecutionRun } from "@/lib/db/execution-runs"
import type { ExecutionRunStatus } from "@/types/execution/run"

/** Complement of the active set in `lib/execution/control-handlers.ts`. */
const TERMINAL_STATUSES: ReadonlySet<ExecutionRunStatus> = new Set<ExecutionRunStatus>([
  "completed",
  "failed",
  "cancelled",
])

export function isSettledSquadRunStatus(status: ExecutionRunStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

/** Backstop poll, in case a Dexie change event is missed or unavailable. */
const POLL_INTERVAL_MS = 5_000

export interface WatchSquadRunInput {
  /** The EXECUTION run id (`execution:team:<sourceRunId>`), not the raw one. */
  executionRunId: string
  onSettled: (status: ExecutionRunStatus) => void
  onError?: (error: unknown) => void
  /** Disable the Dexie subscription (tests drive the poll deterministically). */
  subscribeDexie?: boolean
  pollIntervalMs?: number
}

export function watchSquadRunSettlement(input: WatchSquadRunInput): () => void {
  let disposed = false
  let checking: Promise<void> | null = null
  const onError = input.onError ?? (() => undefined)

  const dispose = () => {
    if (disposed) return
    disposed = true
    clearInterval(interval)
    unsubscribe?.()
  }

  const check = (): Promise<void> => {
    if (disposed) return Promise.resolve()
    // Serialize: a Dexie change fired while a read is in flight must not
    // re-enter and settle twice.
    if (checking) return checking
    checking = getExecutionRun(input.executionRunId)
      .then((run) => {
        if (disposed || !run) return
        if (!isSettledSquadRunStatus(run.status)) return
        // Dispose FIRST: `onSettled` may start another turn, and a watcher
        // still armed would then be watching a run it no longer represents.
        const status = run.status
        dispose()
        input.onSettled(status)
      })
      .catch(onError)
      .finally(() => {
        checking = null
      })
    return checking
  }

  let unsubscribe: (() => void) | null = null
  if (input.subscribeDexie !== false) {
    try {
      // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build
      // makes `liveQuery` non-enumerable, so SWC's wildcard interop drops it
      // the moment a module also imports the `Dexie` default.
      const subscription = Dexie.liveQuery(async () => {
        const run = await getDb().executionRuns.get(input.executionRunId)
        return run ? `${run.status}:${run.currentRevision}` : ""
      }).subscribe({ next: () => void check(), error: onError })
      unsubscribe = () => subscription.unsubscribe()
    } catch (error) {
      onError(error)
    }
  }

  const interval = setInterval(() => void check(), input.pollIntervalMs ?? POLL_INTERVAL_MS)
  // The run may already be over — a very short Squad run can settle before the
  // caller gets here.
  void check()

  return dispose
}

/**
 * Promise form of {@link watchSquadRunSettlement}, for callers that genuinely
 * want to wait for the outcome (the scheduler, a plugin's `runTeam`, a
 * delegation). Resolves with the terminal status. An aborted `signal` rejects
 * and disposes the watcher.
 */
export function awaitSquadRunSettlement(
  executionRunId: string,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {}
): Promise<ExecutionRunStatus> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("Aborted"))
      return
    }
    const stop = watchSquadRunSettlement({
      executionRunId,
      onSettled: (status) => {
        options.signal?.removeEventListener("abort", onAbort)
        resolve(status)
      },
      onError: () => undefined,
      ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    })
    const onAbort = () => {
      stop()
      reject(options.signal?.reason ?? new Error("Aborted"))
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })
  })
}
