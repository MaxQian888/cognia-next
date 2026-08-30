/**
 * Keeps a claimed memory job owned while its worker runs.
 *
 * `heartbeatMemoryJob` has existed since the table did and had no production
 * caller, so a lease was granted for ten minutes and then simply expired. An
 * extraction that outran the TTL was re-claimed by the next worker tick and run
 * a second time against the same transcript.
 *
 * Modelled on `lib/work-submission/lease-heartbeat.ts`, which solves the same
 * problem for work submissions. The renew period is derived from the TTL rather
 * than restated, because a heartbeat slower than the lease is not a heartbeat.
 */

import { heartbeatMemoryJob, MEMORY_JOB_LEASE_TTL_MS } from "@/lib/db/memory-governance"

export interface MemoryJobHeartbeatDeps {
  heartbeat?: typeof heartbeatMemoryJob
  intervalMs?: number
  now?: () => number
  /**
   * The lease is gone: it expired and another worker took the job, or a user
   * cancelled it. The caller must not write a completion after this.
   */
  onLeaseLost?: () => void
}

export type StopMemoryJobHeartbeat = () => void

export function startMemoryJobHeartbeat(
  jobId: string,
  workerId: string,
  deps: MemoryJobHeartbeatDeps = {}
): StopMemoryJobHeartbeat {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const intervalMs = deps.intervalMs ?? Math.floor(MEMORY_JOB_LEASE_TTL_MS / 3)
  const renew = deps.heartbeat ?? heartbeatMemoryJob

  const stop: StopMemoryJobHeartbeat = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void renew(jobId, workerId, deps.now?.() ?? Date.now())
        .then((job) => {
          // `undefined` is the fence refusing us: not running, not ours, or
          // already expired. Either way we no longer own the job.
          if (job) schedule()
          else {
            stop()
            deps.onLeaseLost?.()
          }
        })
        .catch(() => {
          // A failed renew is indistinguishable from a lost lease from here, so
          // treat it as lost and let the reclaim path decide.
          stop()
          deps.onLeaseLost?.()
        })
    }, intervalMs)
  }

  schedule()
  return stop
}
