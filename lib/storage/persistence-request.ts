/**
 * Persistent-storage request helper.
 *
 * IndexedDB (and therefore every Dexie table this app relies on) is *evictable*
 * by default: under storage pressure — and unconditionally in Safari/iOS
 * private mode — the browser may silently discard the origin's data. The
 * `navigator.storage.persist()` API upgrades the origin to the "persistent"
 * bucket, which the browser won't evict without explicit user action. Nothing
 * in the app requested it before, so a heavy user could lose conversations,
 * drafts and settings with no warning.
 *
 * `requestPersistentStorage()` is safe to call once on boot: it's idempotent
 * (a no-op when already persisted), never throws (jsdom / old Tauri webviews
 * lack the API), and reports a coarse status the UI can surface.
 */

export type PersistenceStatus = "persisted" | "denied" | "unsupported"

/**
 * Ask the browser to make this origin's storage persistent. Returns:
 *  - `"persisted"` — already persistent, or the request was granted,
 *  - `"denied"`    — the browser declined (heuristics not met yet),
 *  - `"unsupported"` — the Storage API isn't available (SSR / jsdom / old webview).
 */
export async function requestPersistentStorage(): Promise<PersistenceStatus> {
  if (typeof navigator === "undefined" || !navigator.storage) return "unsupported"
  const storage = navigator.storage
  try {
    if (typeof storage.persisted === "function" && (await storage.persisted())) {
      return "persisted"
    }
    if (typeof storage.persist !== "function") return "unsupported"
    const granted = await storage.persist()
    return granted ? "persisted" : "denied"
  } catch {
    return "unsupported"
  }
}

/** Read-only check of the current persisted state. `false` when the API is
 * unavailable or the origin isn't persistent. Never throws. */
export async function isStoragePersisted(): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.persisted !== "function") {
    return false
  }
  try {
    return await navigator.storage.persisted()
  } catch {
    return false
  }
}
