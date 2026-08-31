/**
 * Session-scoped history of hot-reload-relevant events the plugin
 * runtime saw. Populates the DevTools "Hot-reload diagnostics" panel and
 * dedupes near-simultaneous events from the bridge, which fires both
 * `cli-bridge:plugin-installed` and `plugin-hot-reload` on a
 * reload-via-install path.
 *
 * Writers (every production path that can change what is loaded):
 *   - `hooks/plugins/use-cli-bridge-events.ts` for install and uninstall
 *     reported by the loopback CLI bridge.
 *   - `lib/cli-bridge/renderer-request-source.ts` for the
 *     `plugin_dev_reload` round-trip, recorded twice: `in-progress` when
 *     the request starts, then the verified outcome when it settles.
 *
 * Capped at 20 entries (newest first). Not persisted: the panel is a
 * diagnostics surface, not a log file.
 */

import { create } from "zustand"

const MAX_ENTRIES = 20
const DEDUPE_WINDOW_MS = 500
/**
 * How long an `in-progress` row stays eligible to be settled in place by a
 * later `success` or `failed` for the same plugin and kind. A reload request
 * gives up after 20 s (`PluginDevReloadDependencies.timeoutMs`), so a minute
 * covers every real attempt while keeping a much older, never-resolved row
 * from absorbing an outcome that belongs to a different attempt.
 */
const IN_PROGRESS_SETTLE_MS = 60_000

export type HotReloadKind = "install" | "uninstall" | "hot-reload"
export type HotReloadStatus = "success" | "failed" | "in-progress"

export interface HotReloadEntry {
  pluginId: string
  /** Who drove it: `"cli"` for the loopback bridge, `"app"` for an in-app watch. */
  source: string
  kind: HotReloadKind
  status: HotReloadStatus
  timestamp: number
  /** Optional human-readable note, e.g. the failure message. */
  note?: string
}

interface HotReloadHistoryState {
  entries: HotReloadEntry[]
  record: (entry: HotReloadEntry) => void
  clear: () => void
}

function isTerminal(status: HotReloadStatus): boolean {
  return status !== "in-progress"
}

export const useHotReloadHistoryStore = create<HotReloadHistoryState>((set, get) => ({
  entries: [],
  record: (entry) => {
    const existing = get().entries
    // 1. Drop echoes. Both `cli-bridge:plugin-installed` AND the global
    //    `plugin-hot-reload` channel fire on a reload-via-install path, so
    //    the second arrival would double the row. Status is part of the key
    //    because a real state change is not an echo.
    const echo = existing.find(
      (e) =>
        e.pluginId === entry.pluginId &&
        e.kind === entry.kind &&
        e.status === entry.status &&
        entry.timestamp - e.timestamp <= DEDUPE_WINDOW_MS
    )
    if (echo) return

    // 2. Settle in place. One reload writes `in-progress` and then its
    //    outcome. Showing both as separate rows would double every line in
    //    the panel and leave a spinner that never stops.
    if (isTerminal(entry.status)) {
      const pendingIndex = existing.findIndex(
        (e) =>
          e.pluginId === entry.pluginId &&
          e.kind === entry.kind &&
          e.status === "in-progress" &&
          entry.timestamp - e.timestamp <= IN_PROGRESS_SETTLE_MS
      )
      if (pendingIndex >= 0) {
        const settled = [...existing]
        settled[pendingIndex] = entry
        set({ entries: settled })
        return
      }
    }

    set({
      entries: [entry, ...existing].slice(0, MAX_ENTRIES),
    })
  },
  clear: () => set({ entries: [] }),
}))

/**
 * Imperative entry point used by the bridge-events hook and the cli-bridge
 * request dispatcher. Identical to calling
 * `useHotReloadHistoryStore.getState().record(entry)`, but the separate
 * function keeps a caller's import surface small: it pulls in a function,
 * not the whole zustand machinery.
 */
export function recordHotReloadEvent(entry: HotReloadEntry): void {
  useHotReloadHistoryStore.getState().record(entry)
}
