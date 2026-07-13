// Shared types for the unified-shortcut system. Mirrored on the Rust side in
// `src-tauri/src/shortcuts/registry.rs` — keep field names in lockstep so the
// DTO round-trips cleanly through `invoke()`.

export type Modifier = "Ctrl" | "Alt" | "Shift" | "Meta"

/**
 * Canonical chord string format: "Ctrl+Shift+Space", "Alt+K", "F1". Stored
 * normalized via `lib/shortcuts/utils.ts:normalizeKeyCombo` so case and
 * modifier order can't break comparisons.
 */
export type Chord = string

/**
 * Which backend owns a shortcut's persistence + dispatch. The unified
 * settings page projects all three, but each still writes through exactly
 * one store (see `lib/shortcuts/unified.ts`):
 *
 *   - `global` — OS-level `tauri-plugin-global-shortcut` registrations,
 *     registered from Rust and persisted via `useShortcutStore`
 *     (`cognia.store.json:shortcuts.custom.v1`). Desktop only. Tray-menu
 *     items that carry an `accelerator` are also `global` — a tray
 *     accelerator is just a global chord with a menu-display mirror.
 *   - `app` — renderer-wide keydown shortcuts dispatched by the single
 *     `use-app-shortcut-dispatcher`, persisted via the app keybinding store
 *     (localStorage). Works in web + desktop.
 *   - `editor` — Monaco/canvas editor keybindings, persisted via
 *     `useKeybindingStore` (localStorage) and consumed by the editor.
 */
export type ShortcutScope = "global" | "app" | "editor"

export interface ShortcutBinding {
  /**
   * Stable id. For `global` this matches a built-in id like `tray.show` /
   * `tray.open-logs` / `tray.automation-kill`, a tray item id, or a command
   * id (e.g. `pet.toggle-window`). For `app` / `editor` it matches a
   * `ShortcutDescriptor.id` in the corresponding catalog.
   */
  id: string
  chord: Chord
  scope: ShortcutScope
  /** Optional human label for the settings UI; defaults to `id` when absent. */
  label?: string
}

/**
 * Static, renderer-only description of a rebindable shortcut — the single
 * source of truth for its default chord, label, grouping, scope, and
 * activation guard. Descriptors live in code (never persisted, never cross
 * IPC); only the user's *override* chord is persisted, keyed by `id` in the
 * store that owns the descriptor's `scope`. The unified settings page and
 * the per-feature dialogs both render from these, so a chord shown in one
 * surface always matches the chord that actually fires.
 */
export interface ShortcutDescriptor {
  /** Stable id; also the persistence key and (unless `commandId` overrides) the command/plugin dispatch id. */
  id: string
  scope: ShortcutScope
  /** i18n key for the row label, e.g. `settings.shortcuts.catalog.terminalToggle`. */
  labelKey: string
  /** Grouping key used to bucket rows in the settings UI (e.g. `app.terminal`, `editor.action`). */
  category: string
  /** Default chord in canonical form, or `""` when the shortcut ships unbound. */
  defaultChord: Chord
  /**
   * Optional additional chords the runtime should also accept for this
   * action (e.g. `-`/`_` and `=`/`+` for zoom). Not user-editable; the
   * primary `defaultChord`/override is what the recorder shows and rebinds.
   */
  altChords?: Chord[]
  /**
   * Optional VS Code-style `when` clause gating activation, evaluated via
   * `lib/plugin/context-keys/when-evaluator.ts:evaluateContextWhen`.
   */
  when?: string
  /** Command/plugin dispatch id; defaults to `id` when absent. */
  commandId?: string
  /** `false` = display-only (gesture or externally-driven); not rebindable. Defaults to `true`. */
  editable?: boolean
}
