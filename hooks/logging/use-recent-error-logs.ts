"use client"

/**
 * The in-memory recent-error buffer, read the only way React can safely read it.
 *
 * `recordRecentErrorLog` sits on the console bridge's **synchronous** path: a
 * `console.error` raised inside any component's render reaches subscribers
 * before that render finishes. Waking React there — with `useState` *or* with a
 * plain `useSyncExternalStore` subscription, both were measured — produces
 * "Cannot update a component while rendering a different component". Every
 * surface that watches this buffer is one `console.error` away from that
 * warning, so the safe read lives here once instead of in each of them.
 *
 * Two things make it safe:
 *
 *   - `getRecentErrorLogsSnapshot` returns the buffer *by reference*. The
 *     buffer is replaced rather than mutated, so its identity is a valid
 *     snapshot; the public reader slices and therefore cannot be one.
 *   - the subscription hands the wake-up to a microtask. The buffer is already
 *     correct when the notification fires — only the re-render waits — and
 *     `useSyncExternalStore` re-reads the snapshot on every render, so a
 *     deferred wake-up cannot lose an entry.
 */

import { useSyncExternalStore } from "react"

import { getRecentErrorLogsSnapshot, subscribeRecentErrorLogs } from "@cognia/logging/recent-errors"
import type { StructuredLogEntry } from "@/types/logging"

/** Module-level: `useSyncExternalStore` resubscribes whenever `subscribe`
 * changes identity, so this must not be recreated per render. */
const subscribeDeferred = (onStoreChange: () => void): (() => void) =>
  subscribeRecentErrorLogs(() => queueMicrotask(onStoreChange))

/**
 * Newest first, unfiltered and unsliced — callers derive what they need with a
 * `useMemo`, which keeps the snapshot identity intact.
 */
export function useRecentErrorLogs(): StructuredLogEntry[] {
  return useSyncExternalStore(
    subscribeDeferred,
    getRecentErrorLogsSnapshot,
    getRecentErrorLogsSnapshot
  )
}
