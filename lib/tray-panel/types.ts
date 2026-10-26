// Shared types for the tray quick panel — the popover that opens when the user
// clicks the tray icon (Rust side: `src-tauri/src/tray/panel.rs`).
//
// The split mirrors the tray menu's: Rust owns the window and the anchor, the
// renderer owns the action catalogue, i18n, and `when` filtering. Nothing in
// this file crosses IPC as-is except `TrayPanelRunRequest`, which travels
// panel-window → main-window over `emitTo`.

import type { TrayNativeAction } from "@/lib/tray/types"
import type {
  TrayPanelDelegateTarget,
  TrayPanelEffect,
  TrayPanelField,
  TrayPanelTrigger,
} from "@cognia/plugin-contract/lib/tray-panel/types"
export type {
  TrayPanelAction,
  TrayPanelDelegateTarget,
  TrayPanelEffect,
  TrayPanelField,
  TrayPanelFieldRef,
  TrayPanelNumberField,
  TrayPanelSelectField,
  TrayPanelSelectOption,
  TrayPanelSwitchField,
  TrayPanelTextField,
  TrayPanelTextareaField,
  TrayPanelTrigger,
} from "@cognia/plugin-contract/lib/tray-panel/types"

/* ── Fields ───────────────────────────────────────────────────────────── */

export type TrayPanelFieldKind = TrayPanelField["kind"]

/** The value a field currently holds. Switches are booleans; the rest strings. */
export type TrayPanelFieldValue = string | boolean | number

export type TrayPanelValues = Record<string, TrayPanelFieldValue>

/* ── Effects ──────────────────────────────────────────────────────────── */

export type TrayPanelEffectKind = TrayPanelEffect["kind"]

/* ── Triggers ─────────────────────────────────────────────────────────── */

export type TrayPanelTriggerKind = TrayPanelTrigger["kind"]

/* ── Actions ──────────────────────────────────────────────────────────── */

/* ── Cross-window request ─────────────────────────────────────────────── */

/** An effect with every `{{placeholder}}` already resolved. */
export type TrayPanelResolvedEffect =
  | { kind: "delegate"; prompt: string; target: TrayPanelDelegateTarget; autoSend: boolean }
  | { kind: "slash"; line: string }
  | { kind: "command"; commandId: string }
  | { kind: "native"; action: TrayNativeAction }
  | { kind: "navigate"; path: string }

/** Panel window → main window, over `tray-panel://run`. */
export interface TrayPanelRunRequest {
  /** Correlates the result event back to the panel's pending state. */
  requestId: string
  actionId: string
  /** Resolved label, for the toast the main window raises on failure. */
  actionLabel: string
  effect: TrayPanelResolvedEffect
  /** Bring the main window forward as part of running this. */
  focusMainWindow: boolean
}

/** Main window → panel window, over `tray-panel://result`. */
export interface TrayPanelRunResult {
  requestId: string
  ok: boolean
  /** Present when `ok` is false — already-translated, safe to render. */
  error?: string
}

/** Persisted panel preferences owned by Rust (`tray-panel.json`). */
export type TrayLeftClickAction = "panel" | "toggle-window" | "none"

export interface TrayPanelConfig {
  leftClick: TrayLeftClickAction
  width: number
  height: number
}
