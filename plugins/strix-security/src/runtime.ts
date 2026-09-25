// Module-level bridge from the plugin `ctx` (available only in activate()) to
// the React panel (which receives only `ContextPanelRenderProps`). `activate`
// stashes the APIs here; the panel + runner read them via `getStrixRuntime()`.
// Mirrors pet-daily-quests' `configureQuestStore` decoupling.
//
// The two slots below the runtime are process state, not React state, on
// purpose: the panel can unmount (resource switch, workbench collapse) while a
// scan keeps running, and a remounted panel still needs to cancel it; a
// `/security <target>` dispatch can arrive while no panel is mounted and must
// survive until one is.

import type {
  PluginContextPanelAPI,
  PluginDexieAPI,
  PluginI18nAPI,
  PluginSecurityScansAPI,
  PluginTerminalAPI,
  PluginUIAPI,
} from "@cognia/plugin-sdk"

export interface StrixRuntime {
  terminal: PluginTerminalAPI
  /**
   * Null when the manifest's Dexie tables could not be mounted. The panel then
   * says storage is unavailable — not that Docker is missing — and offers no
   * scan it could not record.
   */
  dexie: PluginDexieAPI | null
  securityScans: PluginSecurityScansAPI
  /**
   * Host-owned dialogs/toasts. Always present: a confirmation that cannot be
   * shown must not be treated as a "yes" (the old `?? true` did exactly that).
   */
  ui: Pick<PluginUIAPI, "showConfirmDialog" | "showToast">
  /** The workbench API the panel was registered through (rail badge). */
  contextPanels: Pick<PluginContextPanelAPI, "setBadge">
  /** `ctx.i18n.formatDate` — dates follow the APP locale, not the OS one. */
  formatDate: PluginI18nAPI["formatDate"]
}

let runtime: StrixRuntime | null = null

export function setStrixRuntime(rt: StrixRuntime): void {
  runtime = rt
}

export function clearStrixRuntime(): void {
  runtime = null
}

/** Runtime if wired, else null (panel renders a disabled state). */
export function peekStrixRuntime(): StrixRuntime | null {
  return runtime
}

/** Runtime or throw — for call sites that require it (the runner). */
export function getStrixRuntime(): StrixRuntime {
  if (!runtime) {
    throw new Error("strix-security: runtime not initialized (plugin not activated)")
  }
  return runtime
}

// ------------------------------------------------------------ active scan

/**
 * The scan currently driving a PTY, if any. Only one runs at a time (the form
 * gates on it), so a single slot suffices. Keyed by runId so a stale holder
 * can be detected rather than aborted by accident.
 */
let activeScan: { runId: string; controller: AbortController } | null = null

export function setActiveScan(runId: string, controller: AbortController): void {
  activeScan = { runId, controller }
}

export function getActiveScan(): { runId: string; controller: AbortController } | null {
  return activeScan
}

export function clearActiveScan(runId?: string): void {
  if (!runId || activeScan?.runId === runId) activeScan = null
}

/**
 * Abort the in-flight scan, wherever the request came from — the panel's
 * cancel button, the run journal's controller, or plugin teardown. The runner
 * translates the abort into a `cancelled` run row and kills the PTY itself.
 */
export function abortActiveScan(): void {
  activeScan?.controller.abort()
}

// ---------------------------------------------------------- pending target

/**
 * A scan target carried in by `/security <target>`. One-shot: the first
 * mounted ScanForm consumes it. `onCommand` cannot pass props to a panel that
 * may not be mounted yet, so the hand-off lives here.
 */
let pendingTarget: string | null = null

export function setPendingTarget(target: string): void {
  pendingTarget = target
}

export function consumePendingTarget(): string | null {
  const target = pendingTarget
  pendingTarget = null
  return target
}
