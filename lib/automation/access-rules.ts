/**
 * One model for "which targets may automation touch".
 *
 * Two rule sets used to be edited from two different Settings sections that
 * never mentioned each other: the global whitelist under Settings then
 * Automation then Whitelist, and the per-action policy under Settings then
 * Sandbox then Automation policy. A user who allowed `notepad.exe` in one had
 * no signal the other existed and still denied.
 *
 * They are not two copies of one gate. Rust runs them at different moments
 * with opposite logic, so this module unifies the document, the read and the
 * write, and keeps the two stages explicit rather than collapsing them:
 *
 * - `admit` is stage one, inside `PermissionGate::evaluate`
 *   (`automation/permission.rs`). **OR**: an empty rule set admits everything,
 *   otherwise any single match admits. Process names compare exactly and
 *   case-insensitively, window titles use a tiny `*` glob that falls back to a
 *   substring test when the pattern has no `*`. Only consulted under the
 *   `whitelist` tier. Stored on `AutomationSettings.whitelist`.
 *
 * - `restrict` is stage two, in the dispatcher, for the Computer Use surface
 *   only, and only *after* consent resolves (`automation/dispatcher.rs`).
 *   **AND**: every non-empty list must match or the call is denied. Patterns
 *   are regular expressions, not globs. Stored on `AppSettings.automationPolicy`
 *   and pushed into Rust state.
 *
 * A third layer, `policy.rs::evaluate_hard_target`, refuses Cognia itself,
 * terminal emulators, macOS authentication windows and browser security pages.
 * No setting edits it, which is why nothing here exposes it.
 */

import type { AutomationPolicy } from "@cognia/agent-config-types"
import { DEFAULT_AUTOMATION_POLICY } from "@cognia/agent-config-types"

import { desktop, defaultAutomationSettings, type Whitelist } from "@/lib/automation/client"
import { getAutomationPolicy, saveAutomationPolicy } from "@/lib/automation/policy"
import { isTauri } from "@/lib/tauri"

export interface AutomationAccessRules {
  /** Stage one. Any match admits. Empty admits everything. */
  admit: Whitelist
  /** Stage two. Every non-empty list must match. Empty adds no constraint. */
  restrict: AutomationPolicy
}

export function defaultAutomationAccessRules(): AutomationAccessRules {
  return {
    admit: { processNames: [], windowTitlePatterns: [] },
    restrict: { ...DEFAULT_AUTOMATION_POLICY },
  }
}

export function isAdmitEmpty(admit: Whitelist): boolean {
  return admit.processNames.length === 0 && admit.windowTitlePatterns.length === 0
}

export function isRestrictEmpty(restrict: AutomationPolicy): boolean {
  return (
    restrict.allowedProcessNames.length === 0 &&
    restrict.allowedWindowTitlePatterns.length === 0 &&
    restrict.allowedUrlPatterns.length === 0 &&
    restrict.forbiddenScreenRegions.length === 0
  )
}

/**
 * Read both stages as one document. Off the desktop shell neither store is
 * reachable, so this answers with the defaults rather than throwing: the
 * editor renders its unavailable notice instead.
 */
export async function getAutomationAccessRules(): Promise<AutomationAccessRules> {
  if (!isTauri()) return defaultAutomationAccessRules()
  const [settings, restrict] = await Promise.all([desktop.settingsGet(), getAutomationPolicy()])
  return { admit: settings.whitelist, restrict }
}

/**
 * Write both stages as one edit.
 *
 * The two live in different stores, so a partial write is possible and would
 * leave the user looking at rules that are half applied. `admit` goes first
 * because it is the cheaper rollback: if `restrict` fails, the previous
 * `admit` is put back and the error is rethrown, so the editor can report a
 * failure over state that still matches what Rust holds.
 */
export async function saveAutomationAccessRules(next: AutomationAccessRules): Promise<void> {
  if (!isTauri()) return
  const settings = await desktop.settingsGet()
  const previousAdmit = settings.whitelist
  await desktop.settingsSet({ ...settings, whitelist: next.admit })
  try {
    await saveAutomationPolicy(next.restrict)
  } catch (error) {
    await desktop
      .settingsSet({ ...settings, whitelist: previousAdmit })
      // A failed rollback must not mask the error that caused it.
      .catch(() => {})
    throw error
  }
}

/**
 * Fill the focused window into an admit rule. The capture button used to build
 * this inline in the tab, which meant the empty-string guard lived in the view.
 */
export async function captureFocusedTarget(): Promise<{
  processName: string | null
  windowTitle: string | null
}> {
  const focus = await desktop.getFocus()
  return {
    processName: focus.processName?.trim() ? focus.processName : null,
    windowTitle: focus.windowTitle?.trim() ? focus.windowTitle : null,
  }
}

/** The settings blob an unreachable host stands in with, for the editor's shell. */
export function defaultAdmit(): Whitelist {
  return defaultAutomationSettings().whitelist
}
