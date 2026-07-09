"use client"

/**
 * createTauriEventStore — bridge a Tauri event channel into a
 * `useSyncExternalStore`-compatible external store.
 *
 * Replaces the per-hook `useEffect` + `aliveRef` + manual `unlisten` pattern
 * (see the pre-migration `hooks/fleet/use-fleet-stream.ts`) with one
 * refcounted module-level subscription:
 *
 *   - the Tauri `listen()` starts when the FIRST React subscriber attaches
 *     and is torn down (via `safeUnlisten`) when the LAST one detaches, so
 *     StrictMode's mount→unmount→mount cycle never leaks or double-listens;
 *   - the snapshot is cached with stable identity between events (uSES
 *     requirement — `getSnapshot` must return the same reference until the
 *     data actually changes);
 *   - an optional `backfill` fetch runs AFTER the listener is attached (no
 *     gap where an update could be missed) and merges via `applyBackfill`
 *     so a newer live event is never clobbered by a stale fetch;
 *   - off Tauri (web/SSR) the store is inert: `subscribe` is a no-op and the
 *     snapshot stays at `initial`.
 *
 * Listener-set + snapshot-getter shape follows
 * `lib/i18n/plugin-i18n-registry.ts`.
 */

import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export interface TauriEventStore<T> {
  /** React `useSyncExternalStore` contract. */
  subscribe(onChange: () => void): () => void
  getSnapshot(): T
  /** SSR/static-export fallback: always the initial value. */
  getServerSnapshot(): T
  /** Drop listeners + cached snapshot (tests/HMR). */
  resetForTests(): void
}

export interface TauriEventStoreOptions<T, P> {
  /** Tauri event name to listen on. */
  event: string
  /** Snapshot before any event/backfill arrives (also the server snapshot). */
  initial: T
  /** Fold a live event payload into the snapshot. Default: replace. */
  applyEvent?: (current: T, payload: P) => T
  /** Fetched once per cold attach (first subscriber), AFTER listen resolves. */
  backfill?: () => Promise<T>
  /** Merge the backfill result (e.g. monotonic guard). Default: replace. */
  applyBackfill?: (current: T, fetched: T) => T
}

export function createTauriEventStore<T, P = T>(
  options: TauriEventStoreOptions<T, P>
): TauriEventStore<T> {
  const { event, initial } = options
  const applyEvent = options.applyEvent ?? ((_current: T, payload: P) => payload as unknown as T)
  const applyBackfill = options.applyBackfill ?? ((_current: T, fetched: T) => fetched)

  const listeners = new Set<() => void>()
  let snapshot: T = initial
  let unlisten: (() => void) | undefined
  /** Increments on every teardown so in-flight attach work from a previous
   * generation can detect it is stale and self-unlisten. */
  let generation = 0

  const emit = () => {
    for (const fn of listeners) fn()
  }

  const setSnapshot = (next: T) => {
    if (Object.is(next, snapshot)) return
    snapshot = next
    emit()
  }

  const attach = () => {
    const gen = generation
    void (async () => {
      // Dynamic import keeps the Tauri event module out of web bundles.
      const { listen } = await import("@tauri-apps/api/event")
      if (gen !== generation) return
      const un = await listen<P>(event, (e) => {
        if (gen !== generation) return
        setSnapshot(applyEvent(snapshot, e.payload))
      })
      if (gen !== generation) {
        // Last subscriber left while listen() was in flight.
        safeUnlisten(un)
        return
      }
      unlisten = un

      if (options.backfill) {
        const fetched = await options.backfill()
        if (gen !== generation) return
        setSnapshot(applyBackfill(snapshot, fetched))
      }
    })()
  }

  const detach = () => {
    generation += 1
    if (unlisten) {
      safeUnlisten(unlisten)
      unlisten = undefined
    }
  }

  return {
    subscribe(onChange: () => void): () => void {
      if (!isTauri()) return () => {}
      const cold = listeners.size === 0
      listeners.add(onChange)
      if (cold) attach()
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(onChange)
        if (listeners.size === 0) detach()
      }
    },
    getSnapshot(): T {
      return snapshot
    },
    getServerSnapshot(): T {
      return initial
    },
    resetForTests(): void {
      listeners.clear()
      detach()
      snapshot = initial
    },
  }
}
