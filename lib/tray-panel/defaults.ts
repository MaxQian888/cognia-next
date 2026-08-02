// The tray quick panel's shipped action catalogue.
//
// `label`/`placeholder` strings here are i18n KEYS, not visible text — the
// panel resolves them through `useTranslations()` before rendering, exactly
// like `lib/tray/defaults.ts` does for the menu. Custom actions the user
// authors carry real strings instead and are rendered verbatim; the
// `labelKey`-over-`label` precedence in `resolveLabel` is what keeps the two
// kinds in one list.

import type { TrayPanelAction } from "./types"

/** Tauri-store keys. Versioned so a future shape change can migrate cleanly. */
export const TRAY_PANEL_ACTIONS_PREF = "trayPanel.actions.v1"

/** Field id of the built-in delegate composer, shared by the panel shell. */
export const DELEGATE_PROMPT_FIELD = "prompt"

/**
 * The primary action: a composer that hands a prompt to the app.
 *
 * It is also the worked example of the customization model — the destination
 * and the send-immediately flag are driven by its own `select` and `switch`
 * fields via `{{…}}` refs, so a user reading it in the settings editor can see
 * exactly how to wire their own inputs to an effect.
 */
const DELEGATE_ACTION: TrayPanelAction = {
  id: "trayPanel.delegate",
  label: "trayPanel.actions.delegate.label",
  labelKey: "trayPanel.actions.delegate.label",
  descriptionKey: "trayPanel.actions.delegate.description",
  icon: "send",
  builtIn: true,
  trigger: { kind: "submit" },
  fields: [
    {
      kind: "textarea",
      id: DELEGATE_PROMPT_FIELD,
      label: "trayPanel.actions.delegate.promptLabel",
      labelKey: "trayPanel.actions.delegate.promptLabel",
      placeholderKey: "trayPanel.actions.delegate.promptPlaceholder",
      required: true,
      rows: 3,
      maxLength: 4000,
      submitOnEnter: true,
    },
    {
      kind: "select",
      id: "target",
      label: "trayPanel.actions.delegate.targetLabel",
      labelKey: "trayPanel.actions.delegate.targetLabel",
      defaultValue: "newSession",
      options: [
        {
          value: "newSession",
          label: "trayPanel.targets.newSession",
          labelKey: "trayPanel.targets.newSession",
        },
        {
          value: "activeSession",
          label: "trayPanel.targets.activeSession",
          labelKey: "trayPanel.targets.activeSession",
        },
      ],
    },
    {
      kind: "switch",
      id: "send",
      label: "trayPanel.actions.delegate.autoSendLabel",
      labelKey: "trayPanel.actions.delegate.autoSendLabel",
      defaultValue: true,
    },
  ],
  effect: {
    kind: "delegate",
    prompt: "{{prompt}}",
    target: "{{target}}",
    autoSend: "{{send}}",
  },
}

/**
 * Shipped defaults. Order is the panel's render order; the settings UI
 * reorders in place.
 */
export const DEFAULT_TRAY_PANEL_ACTIONS: TrayPanelAction[] = [
  DELEGATE_ACTION,
  {
    id: "trayPanel.newChat",
    label: "trayPanel.actions.newChat.label",
    labelKey: "trayPanel.actions.newChat.label",
    icon: "message-square-plus",
    builtIn: true,
    trigger: { kind: "hotkey", chord: "mod+n" },
    fields: [],
    effect: { kind: "native", action: "new-chat" },
  },
  {
    id: "trayPanel.openApp",
    label: "trayPanel.actions.openApp.label",
    labelKey: "trayPanel.actions.openApp.label",
    icon: "app-window",
    builtIn: true,
    trigger: { kind: "manual" },
    fields: [],
    effect: { kind: "native", action: "show" },
  },
  {
    id: "trayPanel.agentRuns",
    label: "trayPanel.actions.agentRuns.label",
    labelKey: "trayPanel.actions.agentRuns.label",
    icon: "activity",
    builtIn: true,
    trigger: { kind: "manual" },
    fields: [],
    effect: { kind: "navigate", path: "/agent-runs" },
  },
  {
    id: "trayPanel.scheduler",
    label: "trayPanel.actions.scheduler.label",
    labelKey: "trayPanel.actions.scheduler.label",
    icon: "calendar-clock",
    builtIn: true,
    trigger: { kind: "manual" },
    fields: [],
    effect: { kind: "navigate", path: "/scheduler" },
  },
  {
    // Only meaningful while something is actually running, so it is gated on
    // the same `when` snapshot the tray menu uses.
    id: "trayPanel.stopAutomation",
    label: "trayPanel.actions.stopAutomation.label",
    labelKey: "trayPanel.actions.stopAutomation.label",
    icon: "octagon-x",
    builtIn: true,
    when: "automation.running",
    trigger: { kind: "manual" },
    fields: [],
    effect: { kind: "native", action: "automation-kill" },
  },
  {
    id: "trayPanel.settings",
    label: "trayPanel.actions.settings.label",
    labelKey: "trayPanel.actions.settings.label",
    icon: "settings",
    builtIn: true,
    trigger: { kind: "manual" },
    fields: [],
    effect: { kind: "native", action: "settings" },
  },
]

/** Ids of every action that ships with the app. */
export const BUILT_IN_ACTION_IDS: readonly string[] = DEFAULT_TRAY_PANEL_ACTIONS.map((a) => a.id)

/**
 * Fold shipped actions that a stored list predates back in.
 *
 * Without this a built-in added in a later release would silently never appear
 * for anyone who had already customised their panel — the same gap
 * `lib/tray/store.ts:ensureSyntheticEntries` closes for the menu. A built-in
 * the user explicitly hid stays hidden (it is still *present*, just flagged),
 * so only genuinely-new ids are inserted, at the position they hold in the
 * defaults.
 */
export function ensureBuiltInActions(stored: readonly TrayPanelAction[]): TrayPanelAction[] {
  let out = stored.slice()
  DEFAULT_TRAY_PANEL_ACTIONS.forEach((def, defIndex) => {
    if (out.some((a) => a.id === def.id)) return
    out = out.slice()
    out.splice(Math.min(defIndex, out.length), 0, def)
  })
  return out
}

/**
 * Resolve an action's / field's visible text.
 *
 * Built-ins carry an i18n key; user-authored entries carry literal text. The
 * translator is passed in so this stays a pure function usable from tests and
 * from the settings editor's preview.
 */
export function resolveLabel(
  entry: { label: string; labelKey?: string },
  translate: (key: string) => string
): string {
  if (!entry.labelKey) return entry.label
  try {
    return translate(entry.labelKey)
  } catch {
    // next-intl throws on a missing key. A built-in whose message was dropped
    // should still render *something* clickable rather than crashing the panel.
    return entry.label
  }
}
