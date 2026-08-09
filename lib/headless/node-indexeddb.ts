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

/** In-memory Web Storage — enough for lib modules that persist small UI/state
 * blobs via `window.localStorage` / `sessionStorage`. Non-durable by design:
 * the brain's durable state is Dexie (snapshotted); storage-backed caches
 * just reset per process. */
function memoryStorage(): Storage {
  const map = new Map<string, string>()
  const storage = {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
  }
  return storage as Storage
}

function installMemoryStorage(
  g: Record<string, unknown>,
  key: "localStorage" | "sessionStorage"
): void {
  const descriptor = Object.getOwnPropertyDescriptor(g, key)
  if (descriptor && "value" in descriptor && descriptor.value) return

  // Node 26's built-in localStorage is a configurable accessor whose getter
  // emits an ExperimentalWarning unless --localstorage-file is configured.
  // Headless state is persisted through Dexie, so replace that accessor with
  // the existing in-memory shim without reading it first.
  Object.defineProperty(g, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value: memoryStorage(),
  })
}

/**
 * Install `fake-indexeddb` + a minimal `window` shim onto a global. Idempotent
 * and non-clobbering — a real jsdom window / indexedDB (tests) is left
 * untouched.
 *
 * With `window` shimmed to the bare global, `typeof window` checks route lib
 * modules onto their browser paths, where some reach for Web Storage — shim
 * those too (in-memory) so headless boots don't crash on
 * `sessionStorage is not defined`.
 */
export async function installFakeIndexedDb(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>
): Promise<void> {
  if (typeof g.window === "undefined") g.window = g
  installMemoryStorage(g, "localStorage")
  installMemoryStorage(g, "sessionStorage")
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
  // A long-lived Node/Jest process can replace the global IndexedDB factory
  // between isolated environments while Dexie still holds the previous,
  // non-empty dependency snapshot. Rebind unconditionally to the current
  // environment: checking only for an undefined dependency leaves newly
  // constructed databases attached to the stale factory.
  Dexie.dependencies.indexedDB = g.indexedDB as IDBFactory
  Dexie.dependencies.IDBKeyRange = g.IDBKeyRange as typeof IDBKeyRange
}
