/**
 * Recent searches + recently opened items (ADR-0129).
 *
 * The empty dialog is where people land most often, so it shows what they did
 * last: the queries they typed and the items they opened. Both live in
 * `localStorage`, capped, newest first, and are the only search state that
 * survives a reload. Items are stored as a serialisable projection — no icons,
 * no callbacks — and rehydrated by the dialog with the kind's default icon.
 */

import type { GlobalSearchAction, GlobalSearchItem, GlobalSearchKind } from "./types"

export const RECENT_QUERIES_KEY = "cognia.globalSearch.recentQueries"
export const RECENT_ITEMS_KEY = "cognia.globalSearch.recentItems"
export const MAX_RECENT_QUERIES = 8
export const MAX_RECENT_ITEMS = 12

/** Actions that can round-trip through JSON. `callback` cannot; `quick-action` is stored by id. */
export type StoredRecentAction =
  | Exclude<GlobalSearchAction, { type: "callback" } | { type: "quick-action" }>
  | { type: "quick-action-ref"; fullId: string }

export interface RecentItem {
  id: string
  kind: GlobalSearchKind
  title: string
  subtitle?: string
  meta?: string
  action: StoredRecentAction
  openedAt: number
}

const listeners = new Set<() => void>()
let revision = 0

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null
    return window.localStorage
  } catch {
    return null
  }
}

function readJson<T>(key: string, fallback: T): T {
  const store = storage()
  if (!store) return fallback
  try {
    const raw = store.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as unknown
    return (parsed as T) ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    // Quota / private mode: recents are a nicety, never an error.
  }
}

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeGlobalSearchRecents(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getGlobalSearchRecentsRevision(): number {
  return revision
}

// ---- queries -------------------------------------------------------------

export function listRecentQueries(): string[] {
  const rows = readJson<unknown>(RECENT_QUERIES_KEY, [])
  if (!Array.isArray(rows)) return []
  return rows.filter((r): r is string => typeof r === "string" && r.length > 0)
}

/** Remember a query (trimmed, ≥ 2 chars). Moves an existing entry to the front. */
export function recordRecentQuery(query: string): void {
  const q = query.trim()
  if (q.length < 2) return
  const next = [q, ...listRecentQueries().filter((r) => r !== q)].slice(0, MAX_RECENT_QUERIES)
  writeJson(RECENT_QUERIES_KEY, next)
  notify()
}

export function removeRecentQuery(query: string): void {
  const next = listRecentQueries().filter((r) => r !== query)
  writeJson(RECENT_QUERIES_KEY, next)
  notify()
}

export function clearRecentQueries(): void {
  writeJson(RECENT_QUERIES_KEY, [])
  notify()
}

// ---- items ---------------------------------------------------------------

/** Project an item's action into its stored form; `null` when it cannot be stored. */
export function toStoredAction(action: GlobalSearchAction): StoredRecentAction | null {
  switch (action.type) {
    case "callback":
      return null
    case "quick-action":
      return { type: "quick-action-ref", fullId: action.entry.fullId }
    default:
      return action
  }
}

export function listRecentItems(): RecentItem[] {
  const rows = readJson<unknown>(RECENT_ITEMS_KEY, [])
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (r): r is RecentItem =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as RecentItem).id === "string" &&
      typeof (r as RecentItem).kind === "string" &&
      typeof (r as RecentItem).title === "string" &&
      typeof (r as RecentItem).action === "object"
  )
}

/** Remember an opened item. Items with non-serialisable actions are skipped. */
export function recordRecentItem(item: GlobalSearchItem, openedAt: number = Date.now()): void {
  const action = toStoredAction(item.action)
  if (!action) return
  const stored: RecentItem = {
    id: item.id,
    kind: item.kind,
    title: item.title,
    subtitle: item.subtitle,
    meta: item.meta,
    action,
    openedAt,
  }
  const next = [stored, ...listRecentItems().filter((r) => r.id !== item.id)].slice(
    0,
    MAX_RECENT_ITEMS
  )
  writeJson(RECENT_ITEMS_KEY, next)
  notify()
}

export function removeRecentItem(id: string): void {
  writeJson(
    RECENT_ITEMS_KEY,
    listRecentItems().filter((r) => r.id !== id)
  )
  notify()
}

export function clearRecentItems(): void {
  writeJson(RECENT_ITEMS_KEY, [])
  notify()
}

export function clearAllGlobalSearchRecents(): void {
  writeJson(RECENT_QUERIES_KEY, [])
  writeJson(RECENT_ITEMS_KEY, [])
  notify()
}
