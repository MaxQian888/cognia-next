import {
  claimDueHostDispatch,
  completeHostDispatch,
  failHostDispatch,
  markHostDispatchAwaitingResult,
  recoverStrandedHostDispatch,
  terminateHostDispatch,
} from "@/lib/db/host-dispatch-queue"
import {
  deliverHostDispatch,
  HostDispatchDeliveryError,
  type HostDispatchDeliveryOutcome,
} from "./host-dispatch-delivery"
import { recordHostDispatchFailure, type HostDispatchFailure } from "./dispatch-failure-audit"
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"

export interface HostDispatchRunnerOptions {
  accountId: string
  /** Restrict this runner to one enqueue when a caller only wants an eager kick. */
  jobId?: string
  now?: () => number
  leaseOwner?: string
  deliver?: (job: HostDispatchJobRow) => Promise<HostDispatchDeliveryOutcome>
  /**
   * Surface a terminal dispatch. Injected only so tests can assert on it —
   * the default is the real notification-center + run-event audit.
   */
  auditFailure?: (job: HostDispatchJobRow, failure: HostDispatchFailure) => Promise<void>
}

export interface HostDispatchRunner {
  kick(): Promise<void>
  stop(): Promise<void>
  isDraining(): boolean
}

/** Durable, single-claim runner shared by all Host→target delivery domains. */
export function createHostDispatchRunner(options: HostDispatchRunnerOptions): HostDispatchRunner {
  const now = options.now ?? Date.now
  const leaseOwner = options.leaseOwner ?? crypto.randomUUID()
  const deliver = options.deliver ?? deliverHostDispatch
  const auditFailure = options.auditFailure ?? recordHostDispatchFailure
  // A terminal outcome has to reach a human, but the audit is never on the
  // critical path: a failed notification must not strand the drain loop.
  const audit = async (job: HostDispatchJobRow, failure: HostDispatchFailure): Promise<void> => {
    try {
      await auditFailure(job, failure)
    } catch {
      // Best-effort by contract (see dispatch-failure-audit).
    }
  }
  let active: Promise<void> | null = null
  let stopped = false

  const kick = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (active) return active
    active = (async () => {
      await recoverStrandedHostDispatch(options.accountId, now(), options.jobId)
      while (!stopped) {
        const [job] = await claimDueHostDispatch(
          options.accountId,
          now(),
          1,
          leaseOwner,
          undefined,
          options.jobId
        )
        if (!job) break
        if (now() >= job.expiresAt) {
          const at = now()
          await terminateHostDispatch(job.id, "host dispatch deadline expired", "timeout", at)
          await audit(job, {
            kind: "failed",
            code: "timeout",
            error: "host dispatch deadline expired",
            at,
          })
          continue
        }
        try {
          const outcome = await deliver(job)
          if (outcome === "awaiting-result") {
            await markHostDispatchAwaitingResult(job.id, now())
          } else {
            await completeHostDispatch(job.id, now())
          }
        } catch (error) {
          const at = now()
          if (error instanceof HostDispatchDeliveryError && !error.retryable) {
            await terminateHostDispatch(job.id, error.message, error.code, at)
            await audit(job, { kind: "failed", code: error.code, error: error.message, at })
          } else {
            const message = error instanceof Error ? error.message : String(error)
            const status = await failHostDispatch(job.id, message, at)
            // Only the attempt that exhausts the budget is terminal; the
            // retries before it are noise a human must not be paged for.
            if (status === "deadletter") {
              const code =
                error instanceof HostDispatchDeliveryError ? error.code : "delivery_failed"
              await audit(
                { ...job, attempts: job.attempts + 1 },
                { kind: "deadletter", code, error: message, at }
              )
            }
          }
        }
      }
    })().finally(() => {
      active = null
    })
    return active
  }

  return {
    kick,
    async stop() {
      stopped = true
      await active
    },
    isDraining: () => active !== null,
  }
}
