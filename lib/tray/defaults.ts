// Locked default tray layout — see plan §"Default tray layout".
//
// Strings here are i18n keys, not the visible labels. `lib/tray/builder.ts`
// resolves them through the root `useTranslations()` translator (the keys
// already include the `tray.` prefix) before flushing the DTO to Rust.
// Accelerators are the chord strings the Rust shortcut registry
// will report for the corresponding ids; if the user rebinds via the
// settings UI, the renderer will rewrite the field before the next push.

import type { TrayDisplayPrefs, TrayMenuItem } from "./types"

export const DEFAULT_TRAY_ITEMS: TrayMenuItem[] = [
  {
    // Synthetic placeholder — `lib/tray/builder.ts` swaps this for the live
    // status info rows built from the state snapshot. Users can hide it from
    // the settings UI like any other entry.
    kind: "action",
    id: "tray.status",
    label: "tray.status.placeholder",
    payload: { kind: "native", action: "noop" },
  },
  { kind: "separator", id: "tray.sep-0" },
  {
    kind: "action",
    id: "tray.show",
    label: "tray.toggleWindow",
    accelerator: "Ctrl+Shift+Space",
    iconHint: "window",
    payload: { kind: "native", action: "toggle-window" },
  },
  {
    // Second route to the quick panel. The primary one is a left-click on the
    // icon, but that is a user preference (`tray-panel.json:leftClick`) — this
    // row keeps the panel reachable when they have rebound it.
    kind: "action",
    id: "tray.panel-toggle",
    label: "tray.trayPanelToggle",
    iconHint: "window",
    payload: { kind: "native", action: "tray-panel-toggle" },
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
    // Toggle the fleet agent-monitor island overlay from the tray, mirroring
    // the pet toggle. The Rust `island-toggle` native action opens at
    // defaults / hides if visible.
    kind: "action",
    id: "tray.island-toggle",
    label: "tray.islandToggle",
    iconHint: "window",
    payload: { kind: "native", action: "island-toggle" },
  },
  {
    // Quick interactions without opening the widget panel — dispatch through
    // the same `pet.feed`/`pet.play`/`pet.pet` commands the global hotkey
    // and the widget itself use (`lib/pet/commands.ts`), so there's exactly
    // one place that owns the underlying logic. Hidden while the pet
    // subsystem is off (`evaluateWhen` reads `snapshot.pet.enabled`).
    kind: "submenu",
    id: "tray.pet",
    label: "tray.pet.title",
    when: "pet.enabled",
    items: [
      {
        kind: "action",
        id: "tray.pet.feed",
        label: "tray.pet.feed",
        iconHint: "pet",
        payload: { kind: "command", commandId: "pet.feed" },
      },
      {
        kind: "action",
        id: "tray.pet.play",
        label: "tray.pet.play",
        iconHint: "pet",
        payload: { kind: "command", commandId: "pet.play" },
      },
      {
        kind: "action",
        id: "tray.pet.pet",
        label: "tray.pet.pet",
        iconHint: "pet",
        payload: { kind: "command", commandId: "pet.pet" },
      },
      {
        kind: "action",
        id: "tray.pet.sleep",
        label: "tray.pet.sleep",
        iconHint: "pet",
        payload: { kind: "command", commandId: "pet.sleep" },
      },
      {
        kind: "action",
        id: "tray.pet.clean",
        label: "tray.pet.clean",
        iconHint: "pet",
        payload: { kind: "command", commandId: "pet.clean" },
      },
      {
        kind: "action",
        id: "tray.pet.treat",
        label: "tray.pet.treat",
        iconHint: "pet",
        payload: { kind: "command", commandId: "pet.treat" },
      },
      { kind: "separator", id: "tray.pet.sep-0" },
      {
        kind: "action",
        id: "tray.pet.settings",
        label: "tray.pet.openSettings",
        iconHint: "settings",
        payload: { kind: "native", action: "settings" },
      },
    ],
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
    // Synthetic placeholder — `lib/tray/builder.ts` fills the empty items
    // with the live subscription-quota section (`lib/tray/usage-section.ts`)
    // when `TrayDisplayPrefs.showUsageInMenu` is on and usage data exists.
    // Hidden like any other entry via the settings UI.
    kind: "submenu",
    id: "tray.usage",
    label: "tray.usage.title",
    items: [],
  },
  {
    kind: "submenu",
    id: "tray.all-commands",
    label: "tray.allCommands",
    items: [],
  },
  { kind: "separator", id: "tray.sep-2" },
  {
    // Checkable toggle — its tick is resolved from `snapshot.app.autostart`
    // by the builder (the layout never stores the live value). Clicking fires
    // the `toggle-autostart` native action.
    kind: "action",
    id: "tray.autostart",
    label: "tray.autostart",
    iconHint: "autostart",
    checked: false,
    payload: { kind: "native", action: "toggle-autostart" },
  },
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
    // Synthetic placeholder — `lib/tray/builder.ts` fills the empty items with
    // the About cluster (version, docs, issue tracker, data folder, …).
    kind: "submenu",
    id: "tray.about",
    label: "tray.about.title",
    items: [],
  },
  { kind: "separator", id: "tray.sep-4" },
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

/** Display-preferences pref key (`TrayDisplayPrefs`). */
export const TRAY_DISPLAY_PREF = "tray.display.v1"

/**
 * Conservative display defaults: the quota section shows in the menu (it only
 * renders once usage data actually exists), but nothing leaks onto the icon /
 * tooltip / menu-bar title until the user opts in — those are glanceable OS
 * surfaces and quota percentages there are opinionated.
 */
export const DEFAULT_TRAY_DISPLAY: TrayDisplayPrefs = {
  showUsageInMenu: true,
  showUsageInTooltip: false,
  taskbarUsageMode: "off",
  usageAccountKey: null,
  usageRefreshMinutes: 15,
  iconColor: "#000000",
}
