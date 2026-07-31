// Storybook-only Zustand helpers. Stores are module singletons, so state set by
// one story leaks into the next unless it is reset between renders. Stories call
// `resetStore(useXStore)` in `beforeEach` (optionally followed by `seedStore`).
//
// These helpers are intentionally dependency-free: they import NO concrete store,
// so importing this module never drags a store graph (and its potential circular
// imports — see `.storybook/main.ts`) into a story bundle. Each story imports the
// specific store it needs and passes it in.
import type { StoreApi, UseBoundStore } from "zustand"

// A Zustand v5 bound store hook. `getInitialState()` (v5) returns the exact state
// object produced by the `create()` initializer, including action methods.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBoundStore = UseBoundStore<StoreApi<any>>

/** Replace a store's state with its initial state (drops any story mutations). */
export function resetStore(store: AnyBoundStore): void {
  store.setState(store.getInitialState(), true)
}

/** Reset several stores in one call. */
export function resetStores(...stores: AnyBoundStore[]): void {
  for (const store of stores) resetStore(store)
}

/**
 * Shallow-merge a patch into a store's state (Zustand merges top-level keys).
 * Typed against the store's state so the patch is checked at author time.
 */
export function seedStore<T>(store: UseBoundStore<StoreApi<T>>, patch: Partial<T>): void {
  store.setState(patch as Partial<T>)
}
