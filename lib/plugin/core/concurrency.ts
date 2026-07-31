/**
 * Minimal bounded-concurrency worker pool.
 *
 * No `p-limit` / `p-map` dependency exists in this repo and the connector
 * token bucket is throughput-shaped, not a pool — so this is a small, tested
 * primitive for running an array of items through an async worker with at most
 * `limit` in flight at once. Used by the plugin manager to enable a dependency
 * layer concurrently without thundering-herd loads against the sidecar.
 *
 * Resolves once every item has been processed. A worker rejection propagates
 * (the returned promise rejects with the first error); callers that must keep
 * going on per-item failure should catch inside the worker (the manager does).
 */

export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  const max = Math.max(1, Math.floor(limit))
  if (items.length === 0) return

  let cursor = 0
  async function runner(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  }

  const runners: Promise<void>[] = []
  const poolSize = Math.min(max, items.length)
  for (let i = 0; i < poolSize; i++) {
    runners.push(runner())
  }
  await Promise.all(runners)
}
