/**
 * Boot-time driver for the online-evaluation queue.
 *
 * Runs in the renderer only. ADR-0059's headless roster does not bootstrap the
 * renderer logger graph, so nothing enqueues there either — the producer and
 * the consumer are dormant together, which is the honest pairing. Enabling one
 * without the other is what leaves a queue that only grows.
 *
 * The interval is deliberately slow. Online evaluation is a background quality
 * signal, not a live view, and a tight loop against Dexie competes with the
 * chat path for the same single-threaded storage.
 */

import { refreshOnlineEvalPolicyCache, getCachedOnlineEvalPolicies } from "./policy-cache"
import { drainOnlineEvalQueue, type OnlineEvalDrainResult } from "./worker"

export const ONLINE_EVAL_DRAIN_INTERVAL_MS = 60_000
export const ONLINE_EVAL_DRAIN_BATCH = 20

export type Unsubscribe = () => void

export interface OnlineEvalSchedulerDependencies {
  refreshPolicies: () => Promise<number>
  hasPolicies: () => boolean
  drain: (limit: number) => Promise<OnlineEvalDrainResult>
  setIntervalFn: typeof setInterval
  clearIntervalFn: typeof clearInterval
}

const defaultDependencies: OnlineEvalSchedulerDependencies = {
  refreshPolicies: () => refreshOnlineEvalPolicyCache(),
  hasPolicies: () => getCachedOnlineEvalPolicies().length > 0,
  drain: (limit) => drainOnlineEvalQueue(limit),
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
}

/**
 * Start the drain loop. Returns an unsubscribe even when nothing was
 * scheduled, so callers never branch on whether the feature is on.
 *
 * The cache is refreshed on every tick, not just at boot: a policy created
 * after startup must be able to take effect without a reload.
 */
export async function startOnlineEvalScheduler(
  dependencies: Partial<OnlineEvalSchedulerDependencies> = {}
): Promise<Unsubscribe> {
  const deps = { ...defaultDependencies, ...dependencies }
  await deps.refreshPolicies()

  // Drain once at boot regardless — a previous session may have enqueued work
  // it never got to, and leaving it would strand rows the settled-only sweep
  // cannot reach.
  if (deps.hasPolicies()) await deps.drain(ONLINE_EVAL_DRAIN_BATCH).catch(() => undefined)

  const { setIntervalFn, clearIntervalFn } = deps
  const timer = setIntervalFn(() => {
    void (async () => {
      try {
        await deps.refreshPolicies()
        if (!deps.hasPolicies()) return
        await deps.drain(ONLINE_EVAL_DRAIN_BATCH)
      } catch {
        // A background sweep must never take the app down with it.
      }
    })()
  }, ONLINE_EVAL_DRAIN_INTERVAL_MS)

  return () => clearIntervalFn(timer)
}
