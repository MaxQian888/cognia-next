// Locked default tray layout — see plan §"Default tray layout".
//
// Strings here are i18n keys, not the visible labels. `lib/tray/builder.ts`
// resolves them through the root `useTranslations()` translator (the keys
// already include the `tray.` prefix) before flushing the DTO to Rust.
// Accelerators are the chord strings the Rust shortcut registry
// will report for the corresponding ids; if the user rebinds via the
// settings UI, the renderer will rewrite the field before the next push.

import type { TrayMenuItem } from "./types"

export const DEFAULT_TRAY_ITEMS: TrayMenuItem[] = [
  {
    kind: "action",
    id: "tray.show",
    label: "tray.show",
    accelerator: "Ctrl+Shift+Space",
    iconHint: "window",
    payload: { kind: "native", action: "show" },
  },
  {
    kind: "action",
    id: "tray.pet-toggle",
    label: "tray.petToggle",
    iconHint: "pet",
    payload: { kind: "native", action: "pet-toggle" },
  },
  {
    // Unconditional click-through recovery: while the overlay ignores the
    // cursor it can't surface its own menu, so this lives in the tray. The
    // underlying command is idempotent when click-through is already off.
    kind: "action",
    id: "tray.pet-disable-click-through",
    label: "tray.petClickThroughOff",
    iconHint: "pet",
    payload: { kind: "native", action: "pet-disable-click-through" },
  },
  {
    kind: "action",
    id: "tray.new-chat",
    label: "tray.newChat",
    iconHint: "chat",
    payload: { kind: "native", action: "new-chat" },
  },
  {
    kind: "action",
    id: "tray.quick-goal",
    label: "tray.quickGoal",
    iconHint: "goal",
    payload: { kind: "slash", command: "goal" },
  },
  { kind: "separator", id: "tray.sep-1" },
  {
    kind: "submenu",
    id: "tray.all-commands",
    label: "tray.allCommands",
    items: [],
  },
  { kind: "separator", id: "tray.sep-2" },
  {
    kind: "action",
    id: "tray.settings",
    label: "tray.settings",
    iconHint: "settings",
    payload: { kind: "native", action: "settings" },
  },
  {
    kind: "action",
    id: "tray.open-logs",
    label: "tray.openLogs",
    accelerator: "Ctrl+Shift+L",
    iconHint: "logs",
    payload: { kind: "native", action: "open-logs" },
  },
  {
    kind: "action",
    id: "tray.automation-kill",
    label: "tray.automationKill",
    accelerator: "Ctrl+Alt+K",
    iconHint: "kill",
    when: "automation.running",
    payload: { kind: "native", action: "automation-kill" },
  },
  { kind: "separator", id: "tray.sep-3" },
  {
    kind: "action",
    id: "tray.quit",
    label: "tray.quit",
    payload: { kind: "native", action: "quit" },
  },
]

/** Persistence key used by `lib/tray/store.ts` to round-trip the user's
 * customised layout through `lib/tauri/store.ts`. */
export const TRAY_LAYOUT_PREF = "tray.layout.v1"

/** Tooltip pref key. Defaults to "Cognia" until the user changes it. */
export const TRAY_TOOLTIP_PREF = "tray.tooltip.v1"
