"use client"

/**
 * In-memory navigation history for the desktop title bar's VSCode-style
 * back / forward arrows.
 *
 * Next's App Router exposes `router.back()` / `router.forward()` but gives no
 * way to know whether either is possible (no `canGoBack`). To drive the arrows'
 * disabled state we keep our own linear history of visited paths plus a cursor.
 *
 * The title bar is mounted once for the whole desktop shell, so a single
 * `recordNavigation(pathname)` effect there observes every route change. We
 * navigate via `router.push(entries[i])` (rather than `router.back()`) so the
 * cursor and the actual location stay in lock-step — the `internalNav` flag
 * tells `recordNavigation` to ignore the push our own arrows triggered.
 *
 * State is module-level (not persisted) and shared through
 * `useSyncExternalStore`, mirroring the lightweight store pattern already used
 * by `useNarrow()` in `title-bar.tsx`.
 */

import { useSyncExternalStore } from "react"
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime"

interface NavHistoryState {
  entries: string[]
  index: number
}

export interface NavHistorySnapshot {
  canBack: boolean
  canForward: boolean
}

let state: NavHistoryState = { entries: [], index: -1 }
// Set right before we drive a back/forward push so the resulting
// `recordNavigation` call (fired by the pathname change) is a no-op.
let internalNav = false
const listeners = new Set<() => void>()

// useSyncExternalStore requires a referentially-stable snapshot between
// emits, so we cache the object and only rebuild it when state changes.
let snapshot: NavHistorySnapshot = { canBack: false, canForward: false }

function recompute(): void {
  snapshot = {
    canBack: state.index > 0,
    canForward: state.index < state.entries.length - 1,
  }
}

function emit(): void {
  recompute()
  for (const listener of listeners) listener()
}

/**
 * Record a visited path. Called from the title bar on every `usePathname`
 * change. Pushes a new entry (truncating any forward branch), unless the move
 * was triggered by our own back/forward arrows or it repeats the current path.
 */
export function recordNavigation(path: string): void {
  if (internalNav) {
    internalNav = false
    return
  }
  if (state.entries[state.index] === path) return
  const entries = state.entries.slice(0, state.index + 1)
  entries.push(path)
  state = { entries, index: entries.length - 1 }
  emit()
}

/** Move one entry back and navigate there. No-op at the start of history. */
export function navigateBack(router: AppRouterInstance): void {
  if (state.index <= 0) return
  internalNav = true
  state = { ...state, index: state.index - 1 }
  emit()
  router.push(state.entries[state.index])
}

/** Move one entry forward and navigate there. No-op at the end of history. */
export function navigateForward(router: AppRouterInstance): void {
  if (state.index >= state.entries.length - 1) return
  internalNav = true
  state = { ...state, index: state.index + 1 }
  emit()
  router.push(state.entries[state.index])
}

/** Reset the whole history. Primarily for tests. */
export function resetNavHistory(): void {
  state = { entries: [], index: -1 }
  internalNav = false
  emit()
}

/** Current snapshot without subscribing — for tests and imperative reads. */
export function getNavHistorySnapshot(): NavHistorySnapshot {
  return snapshot
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

function getSnapshot(): NavHistorySnapshot {
  return snapshot
}

/** Reactive `{ canBack, canForward }` for the back/forward arrow buttons. */
export function useNavHistory(): NavHistorySnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
