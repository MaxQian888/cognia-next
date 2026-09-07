/**
 * Hold a named Web Lock for as long as something is running.
 *
 * Extracted from the connector runtime's bootstrap, which needed it first and
 * for the same reason the Bot delivery runner does: two webviews of one desktop
 * app share an origin, so they share IndexedDB, and a per-row lease keyed on an
 * account id cannot tell them apart. Whatever guards "one of these per origin"
 * has to be the lock manager.
 *
 * This is NOT `lib/accounts/provisioning-lock.ts` (a short critical section) or
 * `lib/scheduler/tab-lock.ts` (scheduler-specific leader election). The shape
 * here is a lock held for a subsystem's whole lifetime and released by an
 * `AbortSignal`.
 */

/**
 * Request `name` exclusively and hold it until `signal` aborts.
 *
 * Resolves `true` once granted, `false` when this caller's own teardown
 * withdrew the request before it was.
 *
 * The request is QUEUED, not `ifAvailable`, and that matters for two callers:
 *
 * - A second webview waits here until the owner releases (window closed,
 *   subsystem torn down) and then takes over, rather than double-booting while
 *   the owner is alive.
 * - A React StrictMode remount runs effect#1, cleanup#1 and effect#2 in ONE
 *   task, so effect#1's request is still queued when effect#2 issues its own
 *   (a lock manager grants cross-process, never same-task). `ifAvailable` would
 *   refuse effect#2 because effect#1 is queued ahead, leaving NO owner at all.
 *   With `{ signal }`, cleanup#1's abort withdraws effect#1's queued request
 *   and effect#2 is granted next.
 *
 * Degrades to `true` when Web Locks is absent (SSR, an older webview) or the
 * request fails for any reason other than this caller's own abort. No guard,
 * but boot must not be blocked by a missing browser API.
 */
export function acquireExclusiveWebLock(name: string, signal: AbortSignal): Promise<boolean> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks
  if (!locks?.request) return Promise.resolve(true)
  if (signal.aborted) return Promise.resolve(false)
  return new Promise<boolean>((resolveAcquired) => {
    void locks
      .request(name, { signal }, (lock) => {
        if (!lock) {
          resolveAcquired(false)
          return
        }
        resolveAcquired(true)
        // Hold the lock for the subsystem's lifetime. Aborting `signal` after
        // the grant is a no-op for the request itself (per spec), so the
        // release rides on this held promise instead.
        return new Promise<void>((release) => {
          if (signal.aborted) return release()
          signal.addEventListener("abort", () => release(), { once: true })
        })
      })
      .catch((err: unknown) => {
        // AbortError means our own teardown withdrew a still-queued request, so
        // we never owned it. Anything else is a lock-API failure, and degrading
        // to "granted" matches the absent-API path above.
        resolveAcquired(!(err instanceof Error && err.name === "AbortError"))
      })
  })
}
