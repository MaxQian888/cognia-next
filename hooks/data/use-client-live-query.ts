"use client"

import { useLiveQuery } from "dexie-react-hooks"

/**
 * SSR-safe wrapper over `useLiveQuery`. During SSR (where IndexedDB is
 * unavailable), the query function is short-circuited to a Promise of
 * `initial`, which prevents Dexie from being touched on the server.
 *
 * Centralizes the `typeof window === "undefined" ? Promise.resolve(...) : ...`
 * pattern that was duplicated across 10 call sites in components/desktop/.
 */
export function useClientLiveQuery<T>(
  query: () => Promise<T> | T,
  deps: unknown[],
  initial: T
): T | undefined {
  return useLiveQuery<T>(
    () => (typeof window === "undefined" ? Promise.resolve(initial) : query()),
    deps
  )
}
