// Static catalog of `app`-scope shortcuts — renderer-wide keydown actions
// dispatched by the single `use-app-shortcut-dispatcher`. Each descriptor's
// `defaultChord` is the chord the feature hook hardcoded before it moved onto
// the unified dispatcher, so migrating a hook preserves its behavior.
//
// This is inert data: nothing fires until a hook registers a live handler via
// `useAppShortcut`. The catalog grows as hooks migrate (see the Phase 2 plan);
// the unified settings page reads it to render the "App" group.

import { normalizeKeyCombo } from "./utils"
import type { Chord, ShortcutDescriptor } from "./types"

/**
 * App-scope descriptors. Chords are stored pre-normalized (lowercase, modifier
 * order canonical) so `getAcceptedChords` / conflict comparisons never have to
 * re-normalize the defaults.
 */
export const APP_SHORTCUT_CATALOG: ShortcutDescriptor[] = [
  {
    id: "app.search.focus",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.searchFocus",
    category: "app.navigation",
    defaultChord: "/",
  },
  {
    id: "terminal.toggle",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.terminalToggle",
    category: "app.terminal",
    defaultChord: "ctrl+`",
    when: "platform.tauri",
  },
  {
    id: "zoom.in",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.zoomIn",
    category: "app.zoom",
    defaultChord: "ctrl+=",
    // `+` and `=` share a physical key; Shift produces `+`. The dispatcher
    // aliases the shift-variant back so both trigger zoom-in.
    altChords: ["ctrl+shift+="],
    when: "platform.tauri",
  },
  {
    id: "zoom.out",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.zoomOut",
    category: "app.zoom",
    defaultChord: "ctrl+-",
    altChords: ["ctrl+shift+-"],
    when: "platform.tauri",
  },
  {
    id: "zoom.reset",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.zoomReset",
    category: "app.zoom",
    defaultChord: "ctrl+0",
    when: "platform.tauri",
  },
  {
    id: "artifacts.toggleDock",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.artifactsToggleDock",
    category: "app.panels",
    defaultChord: "ctrl+j",
    // Shares Cmd+J with the Canvas right-rail; scoped to the non-Canvas guilds
    // so the two never contend (they also never co-mount).
    when: "!view.canvas",
  },
  {
    id: "canvasLayout.toggleLeft",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.canvasToggleLeft",
    category: "app.canvasLayout",
    defaultChord: "ctrl+b",
    when: "view.canvas",
  },
  {
    id: "canvasLayout.toggleRight",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.canvasToggleRight",
    category: "app.canvasLayout",
    defaultChord: "ctrl+j",
    when: "view.canvas",
  },
  {
    id: "skills.search",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.skillsSearch",
    category: "app.skills",
    defaultChord: "/",
  },
  {
    id: "skills.selectAll",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.skillsSelectAll",
    category: "app.skills",
    defaultChord: "ctrl+a",
  },
  {
    id: "skills.clearSelection",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.skillsClearSelection",
    category: "app.skills",
    defaultChord: "escape",
  },
  {
    id: "skills.create",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.skillsCreate",
    category: "app.skills",
    defaultChord: "n",
  },
  {
    id: "skills.delete",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.skillsDelete",
    category: "app.skills",
    defaultChord: "delete",
    altChords: ["backspace"],
  },
  {
    id: "observability.toggleEdit",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.observabilityToggleEdit",
    category: "app.observability",
    defaultChord: "e",
  },
  {
    id: "observability.refresh",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.observabilityRefresh",
    category: "app.observability",
    defaultChord: "r",
  },
  {
    id: "observability.focusFilter",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.observabilityFocusFilter",
    category: "app.observability",
    defaultChord: "f",
  },
  {
    id: "observability.openSettings",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.observabilityOpenSettings",
    category: "app.observability",
    defaultChord: "s",
  },
  {
    id: "a2ui.undo",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiUndo",
    category: "app.a2ui",
    defaultChord: "ctrl+z",
  },
  {
    id: "a2ui.redo",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiRedo",
    category: "app.a2ui",
    defaultChord: "ctrl+y",
    altChords: ["ctrl+shift+z"],
  },
  {
    id: "a2ui.save",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiSave",
    category: "app.a2ui",
    defaultChord: "ctrl+s",
  },
  {
    id: "a2ui.deleteComponent",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiDelete",
    category: "app.a2ui",
    defaultChord: "delete",
    altChords: ["backspace"],
  },
  {
    id: "a2ui.duplicate",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiDuplicate",
    category: "app.a2ui",
    defaultChord: "ctrl+d",
  },
  {
    id: "a2ui.deselect",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiDeselect",
    category: "app.a2ui",
    defaultChord: "escape",
  },
  {
    id: "a2ui.toggleMode",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.a2uiToggleMode",
    category: "app.a2ui",
    defaultChord: "ctrl+e",
  },
]

const CATALOG_BY_ID: Map<string, ShortcutDescriptor> = new Map(
  APP_SHORTCUT_CATALOG.map((d) => [d.id, d])
)

/** Resolve a descriptor by id, or `undefined` when the id is not in the catalog. */
export function getAppShortcutDescriptor(id: string): ShortcutDescriptor | undefined {
  return CATALOG_BY_ID.get(id)
}

/**
 * All chords that should trigger `id` given its default + alt chords (used when
 * the shortcut is NOT overridden). Returns normalized chords; empty when the id
 * is unknown or ships unbound.
 */
export function getDefaultAcceptedChords(id: string): Chord[] {
  const descriptor = CATALOG_BY_ID.get(id)
  if (!descriptor) return []
  return [descriptor.defaultChord, ...(descriptor.altChords ?? [])]
    .filter((chord) => chord !== "")
    .map(normalizeKeyCombo)
}
