import { renewWorkSubmissionLease, WORK_SUBMISSION_LEASE_TTL_MS } from "@/lib/db/work-submissions"

import type { Unsubscribe } from "./outbox-runner"

interface WorkSubmissionLeaseHeartbeatDeps {
  renew?: typeof renewWorkSubmissionLease
  intervalMs?: number
  now?: () => number
  onError?: (error: unknown) => void
  onLeaseLost?: () => void
}

/** Keep an owned row fenced while live code assembles or hands off the turn. */
export function startWorkSubmissionLeaseHeartbeat(
  submissionId: string,
  leaseOwner: string,
  deps: WorkSubmissionLeaseHeartbeatDeps = {}
): Unsubscribe {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const intervalMs = deps.intervalMs ?? Math.floor(WORK_SUBMISSION_LEASE_TTL_MS / 3)
  const renew = deps.renew ?? renewWorkSubmissionLease

  const stop = () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void renew(submissionId, leaseOwner, deps.now?.() ?? Date.now())
        .then((status) => {
          if (status === "renewed") schedule()
          else {
            stop()
            if (status === "lost") deps.onLeaseLost?.()
          }
        })
        .catch((error) => {
          deps.onError?.(error)
          stop()
          deps.onLeaseLost?.()
        })
    }, intervalMs)
  }
  schedule()
  return stop
}
