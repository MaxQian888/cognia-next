/**
 * Reactive reads over the plugin's own IndexedDB tables.
 *
 * `useLiveQuery(() => ctx.dexie.table("runs").toArray(), [], [])` re-renders
 * whenever a query's tables change. It has to come from this package rather
 * than from `dexie-react-hooks` directly: Dexie's change tracking is a
 * module-level registry, so a copy bundled into a plugin never hears about
 * writes made through the host's Dexie instance (which is what `ctx.dexie`
 * hands out) and the list silently stops updating. This package is resolved to
 * the host's own module graph at load time, so the hook shares the host's
 * Dexie.
 */
import { useLiveQuery as hostUseLiveQuery } from "dexie-react-hooks"

// Keep the host function identity while publishing only this hook's types.
// Re-exporting the upstream barrel leaks unrelated useDocument dependencies
// into every standalone author project importing the UI declaration bundle.
export const useLiveQuery: {
  <T>(querier: () => Promise<T> | T, deps?: unknown[]): T | undefined
  <T, TDefault>(
    querier: () => Promise<T> | T,
    deps: unknown[],
    defaultResult: TDefault
  ): T | TDefault
} = hostUseLiveQuery
