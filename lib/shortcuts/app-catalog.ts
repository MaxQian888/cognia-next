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
    // The unified global search / command palette (ADR-0129). `ctrl` folds
    // with ⌘ in the dispatcher, so one chord serves both platforms; the
    // command id keeps the plugin-facing name the old palette announced.
    //
    // The workflow editor keeps its own editor-local palette on the same chord
    // (`workflow.commandPalette.toggle`), so this one stands down inside it —
    // the exact negation of that descriptor's `when`, which is also what stops
    // `findAppConflict` from reporting the shared `ctrl+k` as a collision.
    id: "app.commandPalette.toggle",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.commandPaletteToggle",
    category: "app.navigation",
    defaultChord: "ctrl+k",
    commandId: "command-palette.toggle",
    when: "!view.workflowEditor",
  },
  {
    id: "app.search.focus",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.searchFocus",
    category: "app.navigation",
    defaultChord: "/",
  },
  // ── Conversation sidebar ─────────────────────────────────────────────────
  //
  // The desktop shell advertises ⌘B for the sidebar in the View menu, the
  // layout dropdown and the shortcuts dialog. Under Tauri the chord is a native
  // menu accelerator (`src-tauri/src/menu.rs`, `toggle-sidebar`) that reaches
  // the renderer through `useMenuEventRouter`, so the DOM binding here is gated
  // to the web shell — registering both would toggle twice on one press. The
  // Canvas rail owns the same chord in its own view (`canvasLayout.toggleLeft`),
  // so the guard is the exact negation of that clause.
  {
    id: "shell.sidebar.toggle",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.sidebarToggle",
    category: "app.panels",
    defaultChord: "ctrl+b",
    when: "!view.canvas && !platform.tauri",
  },
  // Move the active conversation up / down the sidebar's visible order (what
  // the list shows after grouping, filters and search). ⌘⌥[ / ⌘⌥] — bracket
  // pairs read as prev / next the way tab strips bind them, and, unlike a
  // bare or shifted arrow chord, they do nothing inside a textarea, so they can
  // fire while the composer has focus (the normal reading posture).
  {
    id: "shell.conversation.previous",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.conversationPrevious",
    category: "app.navigation",
    defaultChord: "ctrl+alt+[",
  },
  {
    id: "shell.conversation.next",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.conversationNext",
    category: "app.navigation",
    defaultChord: "ctrl+alt+]",
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
    id: "terminal.aiShell.toggle",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.terminalAiShellToggle",
    category: "app.terminal",
    defaultChord: "ctrl+shift+i",
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
    id: "chat.search.toggle",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.chatSearchToggle",
    category: "app.chat",
    defaultChord: "ctrl+f",
    when: "chat.hasMessages",
  },
  {
    id: "chat.timeline.prevAnchor",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.chatPrevAnchor",
    category: "app.chat",
    // Deliberately NOT a bare alt+arrow: that's the native "move by paragraph"
    // binding in a textarea, and these fire while the composer has focus (the
    // normal reading posture), so a bare alt chord would fight the caret.
    // parseKeyEvent folds Ctrl/Cmd, so this is ⌘⌥↑ on macOS and Ctrl+Alt+↑
    // elsewhere.
    defaultChord: "ctrl+alt+up",
    // Registered by the timeline minimap, so it already only fires on desktop
    // in a long-enough conversation; the guard keeps it off an empty session.
    when: "chat.hasMessages",
  },
  {
    id: "chat.timeline.nextAnchor",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.chatNextAnchor",
    category: "app.chat",
    defaultChord: "ctrl+alt+down",
    when: "chat.hasMessages",
  },
  // ── Unified IDE dock ────────────────────────────────────────────────────
  //
  // Only undo/redo ship bound. Splitting, moving, floating, popping out and
  // resetting are reachable from the tab menu and the command palette, and a
  // chord for each would burn five more of a shrinking pool for actions most
  // people do with a pointer. `defaultChord: ""` is the catalog's own idiom for
  // "listed and rebindable, but not bound out of the box".
  {
    id: "dock.layout.undo",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockLayoutUndo",
    category: "app.dock",
    defaultChord: "ctrl+alt+z",
  },
  {
    id: "dock.layout.redo",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockLayoutRedo",
    category: "app.dock",
    defaultChord: "ctrl+alt+shift+z",
  },
  {
    id: "dock.layout.reset",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockLayoutReset",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.panel.close",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockPanelClose",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.panel.float",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockPanelFloat",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.panel.popout",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockPanelPopout",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.panel.redock",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockPanelRedock",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.split.left",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockSplitLeft",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.split.right",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockSplitRight",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.split.up",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockSplitUp",
    category: "app.dock",
    defaultChord: "",
  },
  {
    id: "dock.split.down",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.dockSplitDown",
    category: "app.dock",
    defaultChord: "",
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
  // One chord per *canonical activity*, not per rail position.
  //
  // The workbench shows two faces — six activities with an artifact in front,
  // three without — and plugins add more. Binding "the Nth icon" would make a
  // fixed chord mean different panels depending on what happened to be open,
  // and reordering the rail would silently remap every key. Binding the
  // activity keeps `ctrl+3` meaning "AI" forever; where the mounted workbench
  // has no such panel the chord is simply inert (see
  // `revealActiveWorkbenchActivity`), never a fallback to a neighbour.
  //
  // `ctrl+1..7` are free repo-wide; `ctrl+0` is taken by zoom reset.
  {
    id: "workbench.activity.previewRun",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityPreviewRun",
    category: "app.panels",
    defaultChord: "ctrl+1",
  },
  {
    id: "workbench.activity.review",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityReview",
    category: "app.panels",
    defaultChord: "ctrl+2",
  },
  {
    id: "workbench.activity.ai",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityAi",
    category: "app.panels",
    defaultChord: "ctrl+3",
  },
  {
    id: "workbench.activity.comments",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityComments",
    category: "app.panels",
    defaultChord: "ctrl+4",
  },
  {
    id: "workbench.activity.inspect",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityInspect",
    category: "app.panels",
    defaultChord: "ctrl+5",
  },
  {
    id: "workbench.activity.workspace",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityWorkspace",
    category: "app.panels",
    defaultChord: "ctrl+6",
  },
  {
    id: "workbench.activity.templates",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchActivityTemplates",
    category: "app.panels",
    defaultChord: "ctrl+7",
  },
  {
    id: "workbench.quickSwitch",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workbenchQuickSwitch",
    category: "app.panels",
    defaultChord: "ctrl+shift+e",
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
    // The workflow editor's own command palette (add node / save / run /
    // auto-layout / import-export). ADR-0129 kept editor-local palettes but
    // left this one on a raw `window` listener, so ⌘K inside
    // `/workflows/editor` opened *both* it and the global search. Same chord,
    // opposite `when` ⇒ the dispatcher can only ever fire one of them.
    id: "workflow.commandPalette.toggle",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.workflowCommandPaletteToggle",
    category: "app.workflow",
    defaultChord: "ctrl+k",
    when: "view.workflowEditor",
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
    // Deliberately not a bare letter like its `skills.*` siblings: those are
    // panel-scoped by mount, this one opens the recorder from anywhere.
    //
    // `ctrl+alt+r` is free in this catalog (the only other `ctrl+alt+*` chords
    // are the workbench arrows) and in `reserved.ts` on every platform.
    // `ctrl+shift+r` was rejected — it is Chromium hard-reload, and the app
    // runs against a browser dev server.
    //
    // `when: "platform.tauri"` makes it inert in the web build with no extra
    // guard; registration is additionally suppressed while the owning plugin is
    // disabled, so a disabled recorder never swallows the chord.
    id: "skills.record",
    scope: "app",
    labelKey: "settings.shortcuts.catalog.skillsRecord",
    category: "app.skills",
    defaultChord: "ctrl+alt+r",
    when: "platform.tauri",
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
