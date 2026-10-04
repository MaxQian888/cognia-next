import { startLeaseHeartbeat } from "@/lib/runtime/lease-heartbeat"
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
  const renew = deps.renew ?? renewWorkSubmissionLease
  return startLeaseHeartbeat({
    renew: () => renew(submissionId, leaseOwner, deps.now?.() ?? Date.now()),
    intervalMs: deps.intervalMs ?? Math.floor(WORK_SUBMISSION_LEASE_TTL_MS / 3),
    onError: deps.onError,
    onLeaseLost: deps.onLeaseLost,
  })
}
