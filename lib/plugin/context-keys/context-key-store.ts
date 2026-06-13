"use client"

// Central context-key service — the single source of truth for `when`-clause
// evaluation across plugin contributions (UI slots, commands, view containers,
// webviews, …). Mirrors VS Code's context-key model: a flat map of dotted
// keys (`chat.active`, `platform.tauri`, `route.settings`,
// `plugin.<id>.enabled`) that real app state projects into, plus a `when`
// evaluator that reads it.
//
// State is fed by `components/providers/initializers/context-keys-initializer`
// from the live stores (chat / project / ui / plugin-runtime) + platform +
// pathname. Plugins and host code may also push their own keys via
// `setContextKey` — the map is open, so a plugin can declare a key in its
// activation and gate its own contributions on it.
//
// The tray menu and quick actions keep their own `TrayStateSnapshot` lookup
// (`lib/tray/when.ts`) — same evaluator core, different state model — so this
// store does not disturb those surfaces.

import { create } from "zustand"
import { evaluateWhenExpr, type WhenLookup } from "./when-evaluator"

export type ContextValue = boolean | string | number

interface ContextKeyState {
  /** Flat map of context keys → values. */
  keys: Record<string, ContextValue>
  /** Bumped on every mutation; a stable primitive for `useSyncExternalStore`. */
  revision: number
  setKey: (key: string, value: ContextValue) => void
  setKeys: (entries: Record<string, ContextValue>) => void
  deleteKey: (key: string) => void
  reset: () => void
}

export const useContextKeyStore = create<ContextKeyState>((set) => ({
  keys: {},
  revision: 0,
  setKey: (key, value) =>
    set((state) => {
      if (state.keys[key] === value) return state
      return { keys: { ...state.keys, [key]: value }, revision: state.revision + 1 }
    }),
  setKeys: (entries) =>
    set((state) => {
      let changed = false
      const next = { ...state.keys }
      for (const [k, v] of Object.entries(entries)) {
        if (next[k] !== v) {
          next[k] = v
          changed = true
        }
      }
      if (!changed) return state
      return { keys: next, revision: state.revision + 1 }
    }),
  deleteKey: (key) =>
    set((state) => {
      if (!(key in state.keys)) return state
      const next = { ...state.keys }
      delete next[key]
      return { keys: next, revision: state.revision + 1 }
    }),
  reset: () => set((state) => ({ keys: {}, revision: state.revision + 1 })),
}))

// ── Framework-agnostic accessors (usable outside React, e.g. tray build) ──

/** Set a single context key. */
export function setContextKey(key: string, value: ContextValue): void {
  useContextKeyStore.getState().setKey(key, value)
}

/** Batch-set context keys (one revision bump). */
export function setContextKeys(entries: Record<string, ContextValue>): void {
  useContextKeyStore.getState().setKeys(entries)
}

/** Remove a context key. */
export function deleteContextKey(key: string): void {
  useContextKeyStore.getState().deleteKey(key)
}

/** Current flat snapshot of all context keys. */
export function getContextKeySnapshot(): Record<string, ContextValue> {
  return useContextKeyStore.getState().keys
}

/** A stable primitive for `useSyncExternalStore` snapshots. */
export function getContextKeyRevision(): number {
  return useContextKeyStore.getState().revision
}

/** Subscribe to any context-key change. Returns an unsubscribe function. */
export function subscribeContextKeys(listener: () => void): () => void {
  return useContextKeyStore.subscribe(listener)
}

/** Flat-map lookup over a context snapshot — `chat.active` → keys["chat.active"]. */
function flatLookup(snapshot: Record<string, ContextValue>): WhenLookup {
  return (path) => Boolean(snapshot[path.join(".")])
}

/**
 * Evaluate a `when` clause against the context-key store (or an explicit
 * snapshot, e.g. for a memoised render pass). Returns `true` when the clause
 * is absent. Fail-closed: a malformed expression hides the dependent item
 * rather than throwing, matching the tray/quick-action semantics.
 */
export function evaluateContextWhen(
  expr: string | undefined,
  snapshot: Record<string, ContextValue> = getContextKeySnapshot()
): boolean {
  try {
    return evaluateWhenExpr(expr, flatLookup(snapshot))
  } catch {
    return false
  }
}

/** Test-only: clear all keys and reset the revision. */
export function __resetContextKeysForTesting(): void {
  useContextKeyStore.setState({ keys: {}, revision: 0 })
}
