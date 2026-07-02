/**
 * Node IndexedDB shim (ADR-0059 W2 / T-A1).
 *
 * Canonical home of the fake-indexeddb installer the CLI proved out
 * (`cli/src/db/bootstrap.ts` now delegates here): installs `fake-indexeddb`
 * plus a minimal `window` shim so the desktop `getDb()` (which refuses to run
 * when `window` is undefined) works in Node — the keystone that lets the
 * whole `lib/db/*` Dexie layer run inside the headless brain.
 *
 * Never imported by browser code paths; `fake-indexeddb` loads lazily so the
 * dependency stays out of every web/mobile bundle.
 */
import Dexie from "dexie"

/**
 * Install `fake-indexeddb` + a minimal `window` shim onto a global. Idempotent
 * and non-clobbering — a real jsdom window / indexedDB (tests) is left
 * untouched.
 */
export async function installFakeIndexedDb(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): Promise<void> {
  if (typeof g.window === "undefined") g.window = g
  if (!g.indexedDB) {
    const fake = await import("fake-indexeddb")
    g.indexedDB = new fake.IDBFactory()
    g.IDBKeyRange = fake.IDBKeyRange
  }
  // Dexie 4 snapshots `globalThis.indexedDB` into `Dexie.dependencies` exactly
  // once, at the moment the `dexie` module is first evaluated. Callers import
  // the db layer (which imports Dexie) before installing the shim, so that
  // snapshot already ran — with `indexedDB` still undefined in Node — long
  // before the global is set above. Re-point `Dexie.dependencies` explicitly
  // so every `getDb()` open finds the API; without this, the first real DB
  // read/write rejects with a `MissingAPIError` that surfaces as an unhandled
  // rejection and crashes the process.
  if (!Dexie.dependencies.indexedDB) {
    Dexie.dependencies.indexedDB = g.indexedDB as IDBFactory
    Dexie.dependencies.IDBKeyRange = g.IDBKeyRange as typeof IDBKeyRange
  }
}
