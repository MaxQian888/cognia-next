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
 * Where a shortcut is bound. Tray-bound shortcuts also create an entry in
 * the tray menu's `accelerator` field; global shortcuts are pure Rust-side
 * `tauri-plugin-global-shortcut` registrations.
 */
export type ShortcutScope = "global" | "tray"

export interface ShortcutBinding {
  /**
   * Stable id matching either a tray item id (for `scope: "tray"`) or a
   * built-in id like `tray.show`, `tray.open-logs`, `tray.automation-kill`
   * (for `scope: "global"`).
   */
  id: string
  chord: Chord
  scope: ShortcutScope
  /** Optional human label for the settings UI; defaults to `id` when absent. */
  label?: string
}
