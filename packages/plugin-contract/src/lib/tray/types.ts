/**
 * The plugin contract's share of `lib/tray/types.ts`, which re-exports these.
 */
/**
 * Native window/app actions the tray can fire directly (Rust-handled).
 * Anything not in this list goes through the slash- or command-dispatch
 * path instead.
 */
export type TrayNativeAction =
  | "show"
  | "hide"
  | "toggle-window"
  /** Toggle the tray quick panel (`src-tauri/src/tray/panel.rs`). */
  | "tray-panel-toggle"
  | "new-chat"
  | "settings"
  | "open-logs"
  | "open-data-folder"
  | "copy-diagnostics"
  | "open-docs"
  | "report-issue"
  | "check-updates"
  | "toggle-autostart"
  | "automation-kill"
  | "pet-disable-click-through"
  | "island-toggle"
  | "noop"
  | "quit"
