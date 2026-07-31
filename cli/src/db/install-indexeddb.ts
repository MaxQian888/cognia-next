/**
 * Side-effect preamble — MUST be imported before any `@/lib` module.
 *
 * The CLI reuses the desktop Dexie databases. Dexie 4 snapshots
 * `globalThis.indexedDB` into `Dexie.dependencies` (when the `dexie` module is
 * first evaluated) AND into each instance's private `_deps` (at *construction*
 * time). Some lib databases — notably `lib/scheduler/scheduler-db`'s eager
 * `export const schedulerDb = new SchedulerDatabase()` — are built at module
 * import. If `indexedDB` is not on the global by then, those instances freeze an
 * undefined factory and every open rejects with `MissingAPIError: IndexedDB API
 * missing`, which crashed `/tasks`.
 *
 * `fake-indexeddb/auto` installs a synchronous in-memory IndexedDB onto the
 * global the instant it is imported. That alone is NOT enough, though: the
 * esbuild bundle (code-splitting on) eval​uates several shared chunks — four of
 * which import `dexie` — before this side-effect import runs, so Dexie has
 * already snapshotted an undefined `Dexie.dependencies.indexedDB`. We therefore
 * re-point `Dexie.dependencies` explicitly here. This runs during the eager
 * entry evaluation, BEFORE the TUI is dynamically imported and constructs its
 * eager databases (`schedulerDb`), so those instances freeze the correct
 * factory.
 *
 * It deliberately does NOT install a `window` shim — that is added later by
 * `ensureCliDb`, so `@/lib` modules that branch on `typeof window` (e.g.
 * `lib/logging`) keep their Node behavior during the import phase and never
 * reach for an unshimmed `sessionStorage`.
 *
 * This file must import NOTHING from `@/lib` — that would pull more of the app
 * graph in before the global is set.
 */
import "fake-indexeddb/auto"

import Dexie from "dexie"

const g = globalThis as unknown as { indexedDB?: IDBFactory; IDBKeyRange?: typeof IDBKeyRange }
if (!Dexie.dependencies.indexedDB && g.indexedDB) {
  Dexie.dependencies.indexedDB = g.indexedDB
  if (g.IDBKeyRange) Dexie.dependencies.IDBKeyRange = g.IDBKeyRange
}
