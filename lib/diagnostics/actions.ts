/**
 * What each {@link DiagnosticAction} is called, and who can perform it.
 *
 * Two facts about an action that neither the registry nor the renderer should
 * re-derive:
 *
 *  - its **i18n key**, so every surface labels "Retry" identically;
 *  - its **availability**, which decides whether the action can survive being
 *    written to Dexie as a notification row and clicked days later in a
 *    different window.
 *
 * Availability is the load-bearing one. `retry` means "re-run *that* turn" —
 * only the surface that produced the failure still holds the closure that can
 * do it, so a persisted notification offering a Retry button would be a lie.
 * `open-settings` needs nothing but a router, so it works anywhere. Splitting
 * them is what lets `notify()` fan a diagnostic out to the notification center
 * without shipping dead buttons.
 *
 * Ordering is deliberately NOT here: `DIAGNOSTIC_CODES` already lists each
 * code's actions most-useful-first, so the renderer can style the first one as
 * primary without a second source of truth to keep in sync.
 */

import { DIAGNOSTIC_ACTION_KINDS, actionI18nKey } from "@cognia/diagnostics"
import type { DiagnosticAction, DiagnosticActionKind } from "@cognia/diagnostics"
import type { NotificationAction } from "@/types/notifications"

/**
 * `global` — runnable from anywhere, including a persisted notification row.
 * `host`   — needs live state from the surface that produced the diagnostic
 *            (the failed turn, the crashed boundary, the open editor).
 */
export type DiagnosticActionAvailability = "global" | "host"

export interface DiagnosticActionSpec {
  /** Key under the `diagnostics.action.` i18n sub-namespace. */
  labelKey: string
  availability: DiagnosticActionAvailability
}

const AVAILABILITY: Readonly<Record<DiagnosticActionKind, DiagnosticActionAvailability>> = {
  // Re-running needs the original request; nobody else can reconstruct it.
  retry: "host",
  "wait-and-retry": "host",
  "retry-fallback-provider": "host",
  "retry-when-online": "host",
  "switch-to-builtin": "host",
  "shorten-input": "host",
  "jump-to-node": "host",
  "reset-boundary": "host",

  // Everything below needs only app-level state, so it still works from a
  // notification opened long after the surface that produced it went away.
  "open-settings": "global",
  reauth: "global",
  "restart-sidecar": "global",
  "reconnect-adapter": "global",
  "reconnect-external-agent": "global",
  "copy-install-command": "global",
  "locate-binary": "global",
  "view-logs": "global",
  "open-external": "global",
  "export-crash-log": "global",
  "copy-report": "global",
  "report-issue": "global",
  "reload-app": "global",
  dismiss: "global",
}

export const DIAGNOSTIC_ACTION_SPECS: Readonly<Record<DiagnosticActionKind, DiagnosticActionSpec>> =
  Object.fromEntries(
    DIAGNOSTIC_ACTION_KINDS.map((kind) => [
      kind,
      { labelKey: actionI18nKey(kind), availability: AVAILABILITY[kind] },
    ])
  ) as Record<DiagnosticActionKind, DiagnosticActionSpec>

/** Command key for `lib/notifications/action-registry`. Namespaced to avoid collisions. */
export function diagnosticActionCommand(kind: DiagnosticActionKind): string {
  return `diagnostic.${kind}`
}

/** True when the action still works with no originating surface alive. */
export function isGlobalAction(action: DiagnosticAction): boolean {
  return DIAGNOSTIC_ACTION_SPECS[action.kind].availability === "global"
}

/** The action's payload, minus the discriminant — becomes `NotificationAction.args`. */
function actionArgs(action: DiagnosticAction): Record<string, unknown> | undefined {
  const { kind: _kind, ...rest } = action as { kind: string } & Record<string, unknown>
  return Object.keys(rest).length > 0 ? rest : undefined
}

/**
 * Project a diagnostic's actions onto the notification center's serializable
 * action shape.
 *
 * Host-only actions are dropped rather than rendered dead: `notification-item`
 * shows `action.label` as-is and dispatches by command key, with no way to
 * express "this button can't work right now".
 *
 * `resolveLabel` is injected because `NotificationAction.label` is display text,
 * not a key — the renderer prints it verbatim — so translation has to happen at
 * creation time, where a translator is in scope.
 */
export function toNotificationActions(
  actions: readonly DiagnosticAction[],
  resolveLabel: (kind: DiagnosticActionKind) => string
): NotificationAction[] {
  return actions.filter(isGlobalAction).map((action) => {
    const args = actionArgs(action)
    return {
      id: action.kind,
      label: resolveLabel(action.kind),
      command: diagnosticActionCommand(action.kind),
      ...(args ? { args } : {}),
    }
  })
}
