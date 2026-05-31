/**
 * Shared, ref-counted `matchMedia` store for `useSyncExternalStore`.
 *
 * Every viewport hook (`useMediaQuery`, `useIsMobile`, `useBreakpoint`,
 * `useHasHover`, …) reads through here instead of opening its own
 * `MediaQueryList`. A query gets exactly ONE `MediaQueryList` and ONE
 * `"change"` listener no matter how many components observe it — so 50
 * `useIsMobile()` call sites multiplex onto a single listener rather than 50.
 *
 * The entry for a query is created lazily on first read/subscribe and evicted
 * when its last subscriber unsubscribes, which keeps the cache from leaking and
 * (importantly) keeps test isolation: RTL's auto-cleanup unmounts hooks between
 * tests, dropping subscriber counts to zero and clearing the module cache so a
 * re-mocked `window.matchMedia` is picked up fresh.
 *
 * Framework-free (no React import) so it stays unit-testable in a plain node
 * environment and can be reused by any future non-hook consumer.
 */

interface QueryEntry {
  mql: MediaQueryList
  /** Cached `mql.matches`, refreshed on every `change` and on (re)subscribe. */
  matches: boolean
  listeners: Set<() => void>
  onChange: () => void
}

const entries = new Map<string, QueryEntry>()

function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
}

/** The single `"change"` handler for a query: refresh cache, fan out to listeners. */
function makeOnChange(query: string): () => void {
  return () => {
    const entry = entries.get(query)
    if (!entry) return
    entry.matches = entry.mql.matches
    entry.listeners.forEach((listener) => listener())
  }
}

/** Lazily create (and memoize) the entry for a query. `null` on SSR / no API. */
function ensureEntry(query: string): QueryEntry | null {
  if (!hasMatchMedia()) return null
  const existing = entries.get(query)
  if (existing) return existing

  const mql = window.matchMedia(query)
  const entry: QueryEntry = {
    mql,
    matches: mql.matches,
    listeners: new Set(),
    onChange: makeOnChange(query),
  }
  entries.set(query, entry)
  return entry
}

/**
 * Current match state of `query`. Returns `false` on the server / when
 * `matchMedia` is unavailable, so callers default to the desktop branch.
 * Reads the cached value (stable primitive) — safe for `useSyncExternalStore`.
 */
export function getQuerySnapshot(query: string): boolean {
  const entry = ensureEntry(query)
  return entry ? entry.matches : false
}

/**
 * Subscribe to changes for `query`. The first subscriber attaches the single
 * `"change"` listener; the last to leave detaches it and evicts the entry.
 * Returns an unsubscribe function (no-op on SSR / no `matchMedia`).
 */
export function subscribeToQuery(query: string, callback: () => void): () => void {
  const entry = ensureEntry(query)
  if (!entry) return () => {}

  if (entry.listeners.size === 0) {
    // Refresh in case the MQL changed between creation and first subscribe.
    entry.matches = entry.mql.matches
    entry.mql.addEventListener("change", entry.onChange)
  }
  entry.listeners.add(callback)

  return () => {
    entry.listeners.delete(callback)
    if (entry.listeners.size === 0) {
      entry.mql.removeEventListener("change", entry.onChange)
      entries.delete(query)
    }
  }
}

/**
 * Test-only: drop every cached entry (detaching listeners). Production never
 * needs this — subscriber-driven eviction handles it — but unit tests that
 * read snapshots without mounting a hook leave entries behind that would
 * otherwise leak across cases.
 */
export function __resetViewportStoreForTests(): void {
  for (const entry of entries.values()) {
    entry.mql.removeEventListener("change", entry.onChange)
  }
  entries.clear()
}
