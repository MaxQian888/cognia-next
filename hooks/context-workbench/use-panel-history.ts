"use client"

/**
 * Panel navigation history for the Context Workbench.
 *
 * Tracks a per-scope back/forward stack of previously visited panels, giving
 * users browser-style navigation within the workbench. The history is
 * transient (not persisted to localStorage) — it resets on page reload,
 * exactly like browser tab history.
 *
 * Design constraints:
 * - Each scope has its own independent history stack (max 20 entries).
 * - Reconciliation (panel removal) prunes unreachable entries silently.
 * - The history sits outside the main persisted store to avoid unbounded
 *   growth in localStorage and versioning complexity.
 */

import { useSyncExternalStore, useCallback } from "react"

const HISTORY_MAX_LENGTH = 20

interface ScopeHistory {
  /** Ordered list of panel ids the user navigated through. */
  stack: string[]
  /** Current position in the stack (0 = oldest). */
  index: number
}

const histories = new Map<string, ScopeHistory>()
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision++
  listeners.forEach((listener) => {
    try {
      listener()
    } catch {
      // A broken subscriber cannot block others.
    }
  })
}

function getOrCreate(scopeKey: string): ScopeHistory {
  let history = histories.get(scopeKey)
  if (!history) {
    history = { stack: [], index: -1 }
    histories.set(scopeKey, history)
  }
  return history
}

/**
 * Record a panel navigation. Truncates forward history and appends.
 * Consecutive duplicates are suppressed (clicking the same panel repeatedly
 * does not fill the stack).
 */
export function pushPanelHistory(scopeKey: string, panelId: string): void {
  const history = getOrCreate(scopeKey)

  // Suppress if already at the same panel
  if (history.stack[history.index] === panelId) return

  // Truncate forward history
  const stack = history.stack.slice(0, history.index + 1)
  stack.push(panelId)

  // Cap at max length (drop oldest entries)
  if (stack.length > HISTORY_MAX_LENGTH) {
    stack.splice(0, stack.length - HISTORY_MAX_LENGTH)
  }

  history.stack = stack
  history.index = stack.length - 1
  notify()
}

/** Navigate back; returns the panel id to show, or null at the start. */
export function navigateHistoryBack(scopeKey: string): string | null {
  const history = histories.get(scopeKey)
  if (!history || history.index <= 0) return null
  history.index--
  notify()
  return history.stack[history.index]
}

/** Navigate forward; returns the panel id to show, or null at the end. */
export function navigateHistoryForward(scopeKey: string): string | null {
  const history = histories.get(scopeKey)
  if (!history || history.index >= history.stack.length - 1) return null
  history.index++
  notify()
  return history.stack[history.index]
}

/** Whether a back navigation is possible for the given scope. */
export function canGoBack(scopeKey: string): boolean {
  const history = histories.get(scopeKey)
  return !!history && history.index > 0
}

/** Whether a forward navigation is possible for the given scope. */
export function canGoForward(scopeKey: string): boolean {
  const history = histories.get(scopeKey)
  return !!history && history.index < history.stack.length - 1
}

/** Remove panel ids that no longer exist from the history stack. */
export function pruneHistoryPanels(scopeKey: string, availablePanelIds: Set<string>): void {
  const history = histories.get(scopeKey)
  if (!history) return
  const currentPanelId = history.stack[history.index]
  const pruned = history.stack.filter((id) => availablePanelIds.has(id))
  if (pruned.length === history.stack.length) return // nothing changed
  history.stack = pruned
  history.index = currentPanelId
    ? Math.max(0, pruned.indexOf(currentPanelId))
    : Math.max(0, pruned.length - 1)
  notify()
}

/** Clear the history for a scope (e.g., on unmount). */
export function clearPanelHistory(scopeKey: string): void {
  histories.delete(scopeKey)
  notify()
}

/** Subscribe to history changes (for useSyncExternalStore). */
export function subscribePanelHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getRevision(): number {
  return revision
}

/**
 * Hook to consume panel history state for a given scope key.
 *
 * Returns `canGoBack` / `canGoForward` booleans and `goBack` / `goForward`
 * callbacks that return the target panel id (or null at boundaries).
 */
export function usePanelHistory(scopeKey: string) {
  useSyncExternalStore(subscribePanelHistory, getRevision, getRevision)

  const goBack = useCallback(() => navigateHistoryBack(scopeKey), [scopeKey])
  const goForward = useCallback(() => navigateHistoryForward(scopeKey), [scopeKey])
  const push = useCallback((panelId: string) => pushPanelHistory(scopeKey, panelId), [scopeKey])

  return {
    canGoBack: canGoBack(scopeKey),
    canGoForward: canGoForward(scopeKey),
    goBack,
    goForward,
    push,
  }
}

/** Reset all history state (testing only). */
export function resetPanelHistoryForTesting(): void {
  histories.clear()
  revision = 0
}
