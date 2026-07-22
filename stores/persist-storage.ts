/**
 * Shared zustand-persist storage factory.
 *
 * Every persisted store used to do `createJSONStorage(() => localStorage)`.
 * That relies on a bare `localStorage` reference THROWING outside the browser:
 * zustand wraps the getter in a try/catch and disables persistence when it
 * throws. Node >= 26 broke that assumption — it declares `localStorage` as a
 * real global that evaluates to `undefined` (with an ExperimentalWarning)
 * unless `--localstorage-file` is passed, so nothing throws, zustand keeps the
 * `undefined` storage, and the first `setState` dies with
 * `Cannot read properties of undefined (reading 'setItem')`.
 *
 * That hits every Node-side consumer of a persisted store — CLI, sidecar,
 * headless — not just tests. Resolve the storage explicitly instead of
 * leaning on a ReferenceError.
 */

import { createJSONStorage } from "zustand/middleware"
import type { StateStorage } from "zustand/middleware"

/** Inert storage: persistence is simply skipped when there is no Web Storage. */
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}

/**
 * Resolve the browser's localStorage, or an inert stand-in when unavailable
 * (SSR, the static-export prerender, Node-side CLI/sidecar/headless runs, or a
 * browser that denies storage access).
 */
export function resolvePersistStorage(): StateStorage {
  if (typeof window === "undefined") return noopStorage
  try {
    return window.localStorage ?? noopStorage
  } catch {
    // Safari/Chrome throw on `window.localStorage` when cookies are blocked.
    return noopStorage
  }
}

/**
 * Drop-in replacement for `createJSONStorage(() => localStorage)` in a
 * `persist(...)` config. Behaves identically in the browser.
 */
export function persistLocalStorage() {
  return createJSONStorage(resolvePersistStorage)
}
