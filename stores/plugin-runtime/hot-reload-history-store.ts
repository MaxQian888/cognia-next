/**
 * Session-scoped history of hot-reload-relevant events the plugin
 * runtime saw — used to populate the DevTools "Hot-reload diagnostics"
 * panel and to dedupe near-simultaneous events from the bridge (which
 * fires both `cli-bridge:plugin-installed` and `plugin-hot-reload`
 * on a reload-via-install path).
 *
 * Capped at 20 entries (newest first). Not persisted: the panel is a
 * diagnostics surface, not a log file.
 */

import { create } from "zustand"

const MAX_ENTRIES = 20
const DEDUPE_WINDOW_MS = 500

export type HotReloadKind = "install" | "uninstall" | "hot-reload"
export type HotReloadStatus = "success" | "failed" | "in-progress"

export interface HotReloadEntry {
  pluginId: string
  source: string
  kind: HotReloadKind
  status: HotReloadStatus
  timestamp: number
  /** Optional human-readable note (e.g. "manifest watcher restarted"). */
  note?: string
}

interface HotReloadHistoryState {
  entries: HotReloadEntry[]
  record: (entry: HotReloadEntry) => void
  clear: () => void
}

export const useHotReloadHistoryStore = create<HotReloadHistoryState>((set, get) => ({
  entries: [],
  record: (entry) => {
    const existing = get().entries
    // Dedupe against the most recent same-plugin same-kind entry seen
    // within the window. Both `cli-bridge:plugin-installed` AND the
    // global `plugin-hot-reload` channel fire on a reload-via-install
    // path; dropping the second one keeps the panel readable.
    const candidate = existing.find(
      (e) =>
        e.pluginId === entry.pluginId &&
        e.kind === entry.kind &&
        entry.timestamp - e.timestamp <= DEDUPE_WINDOW_MS
    )
    if (candidate) return
    set({
      entries: [entry, ...existing].slice(0, MAX_ENTRIES),
    })
  },
  clear: () => set({ entries: [] }),
}))

/**
 * Imperative entry point used by the bridge-events hook. Identical to
 * calling `useHotReloadHistoryStore.getState().record(entry)`, but the
 * separate function keeps the hook's import surface small (it only
 * imports a function, not the whole zustand machinery).
 */
export function recordHotReloadEvent(entry: HotReloadEntry): void {
  useHotReloadHistoryStore.getState().record(entry)
}
