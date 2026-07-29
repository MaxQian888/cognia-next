"use client"

/**
 * `useLiveQueryState` — a Dexie live query that keeps its loading signal.
 *
 * `useLiveQuery` already distinguishes the two states perfectly well: it
 * returns `undefined` until the first resolution, and the real value (`[]`
 * included) afterwards. The problem is what call sites do with that — 85 of
 * them collapse it on the spot:
 *
 *     const skills = useLiveQuery(() => listSkills(), []) ?? []
 *
 * After that line "still loading" and "loaded, genuinely empty" are the same
 * value, so the surface renders its empty state during the load and then jumps
 * to content. That reads worse than a skeleton flashing, and it makes a correct
 * loading state impossible to build on top.
 *
 * This returns the three facts separately so the caller never has to choose one
 * and lose the others. Shape deliberately mirrors `useDexieFirstQuery`.
 */

import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"

export interface LiveQueryState<T> {
  /** `undefined` until the first Dexie resolution. */
  data: T | undefined
  /** No result has arrived yet. */
  isLoading: boolean
  /** A result HAS arrived and it holds nothing. Never true while loading. */
  isEmpty: boolean
}

/** Empty means "resolved to nothing": an empty array, or a nullish row. */
function isEmptyResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0
  return value === null
}

export function useLiveQueryState<T>(
  query: () => Promise<T> | T,
  deps: unknown[]
): LiveQueryState<T> {
  // `initial` is undefined on purpose: on the server there is no IndexedDB, and
  // "we have not read yet" is the honest answer there too.
  const data = useClientLiveQuery<T | undefined>(query, deps, undefined)
  const isLoading = data === undefined
  return { data, isLoading, isEmpty: !isLoading && isEmptyResult(data) }
}
