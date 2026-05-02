/**
 * Native runtime helpers re-exported under a single path so plugin code that
 * targets `@/lib/native/utils` stays decoupled from the Tauri detection
 * implementation in `lib/tauri.ts`.
 */

import { isTauri as detectTauri } from "@/lib/tauri"

export { isTauri } from "@/lib/tauri"

/**
 * `canUseTauriInvoke` is the predicate plugin code uses before calling
 * `invoke`. It returns true when Tauri is the host runtime AND the global
 * `__TAURI_INTERNALS__` bridge is present, so unit tests running in jsdom
 * (where `isTauri()` may briefly look truthy via window pollution) don't
 * try to dispatch IPC calls.
 */
export function canUseTauriInvoke(): boolean {
  if (!detectTauri()) return false
  if (typeof window === "undefined") return false
  // The bridge is what `invoke` actually calls into. Its presence is a
  // stronger signal than the marker `isTauri()` checks for.
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
  return Boolean(w.__TAURI_INTERNALS__)
}

/**
 * Stable window labels Tauri uses across the app. The plugin lifecycle
 * needs them to broadcast plugin-state changes to all open windows; we
 * keep the catalog here so adding a new window only requires a single
 * edit.
 */
export const WINDOW_LABELS = {
  MAIN: "main",
  TWIN: "twin",
  AGENT_TEAMS: "agent-teams",
  SCHEDULER: "scheduler",
  PLUGIN_DEVTOOLS: "plugin-devtools",
} as const

export type KnownWindowLabel = (typeof WINDOW_LABELS)[keyof typeof WINDOW_LABELS]
