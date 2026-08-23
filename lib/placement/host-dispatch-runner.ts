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
import type { HostDispatchJobRow } from "@/types/placement/host-dispatch"

export interface HostDispatchRunnerOptions {
  accountId: string
  /** Restrict this runner to one enqueue when a caller only wants an eager kick. */
  jobId?: string
  now?: () => number
  leaseOwner?: string
  deliver?: (job: HostDispatchJobRow) => Promise<HostDispatchDeliveryOutcome>
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
          await terminateHostDispatch(job.id, "host dispatch deadline expired", "timeout", now())
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
          if (error instanceof HostDispatchDeliveryError && !error.retryable) {
            await terminateHostDispatch(job.id, error.message, error.code, now())
          } else {
            await failHostDispatch(
              job.id,
              error instanceof Error ? error.message : String(error),
              now()
            )
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
