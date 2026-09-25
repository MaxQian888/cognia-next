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
export { useLiveQuery } from "dexie-react-hooks"
