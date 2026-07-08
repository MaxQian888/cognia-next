// Shared types for the system-tray client. These mirror the serde DTOs in
// `src-tauri/src/tray/dto.rs`; keep the two in lockstep when extending the
// menu schema.

/**
 * Native window/app actions the tray can fire directly (Rust-handled).
 * Anything not in this list goes through the slash- or command-dispatch
 * path instead.
 */
export type TrayNativeAction =
  | "show"
  | "hide"
  | "toggle-window"
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
  | "pet-toggle"
  | "pet-disable-click-through"
  | "island-toggle"
  | "noop"
  | "quit"

/**
 * What happens when a menu item is clicked. Mirrors `TrayActionPayload` in
 * Rust (serde tagged union; `kind` is the discriminator).
 */
export type TrayActionPayload =
  | { kind: "native"; action: TrayNativeAction }
  | { kind: "slash"; command: string }
  | { kind: "command"; commandId: string }

/**
 * Icon variant the Rust side renders. Selected by either app-state
 * snapshots or a manual override from settings.
 */
export type TrayIconState = "idle" | "busy" | "error" | "muted"

/**
 * One node in the user-visible tray menu tree. Mirrors `TrayMenuItemDto` in
 * Rust. The tree depth is capped at 2 by the Rust builder (Phase B.1) to
 * keep menus navigable.
 */
export type TrayMenuItem = TrayMenuActionItem | TrayMenuSeparator | TrayMenuSubmenu

export interface TrayMenuActionItem {
  kind: "action"
  /** Stable id — also the message-id passed back through `tray://item-clicked`. */
  id: string
  /** Already-translated label (Rust is the dumb container, see plan §"i18n strategy"). */
  label: string
  /** Optional accelerator string, purely cosmetic in the OS menu. */
  accelerator?: string
  /** Optional icon-name hint resolved by the renderer when rebuilding the menu. */
  iconHint?: string
  payload: TrayActionPayload
  /** Optional `when` expression — when set, the renderer filters before flushing to Rust. */
  when?: string
  /** Soft hide while keeping the entry in the user's persisted layout. */
  hidden?: boolean
  /** Disables the entry without removing it. */
  disabled?: boolean
  /**
   * When set, the OS renders the entry as a checkable item with the tick
   * reflecting this boolean (Rust uses `CheckMenuItem`). Used by stateful
   * toggles like "Launch at login". Omit for ordinary (non-checkable) items.
   */
  checked?: boolean
}

export interface TrayMenuSeparator {
  kind: "separator"
  /** Stable id — separators need ids so settings UIs can drag-reorder them. */
  id: string
}

export interface TrayMenuSubmenu {
  kind: "submenu"
  id: string
  label: string
  items: TrayMenuItem[]
  when?: string
  hidden?: boolean
}

/**
 * Snapshot of relevant app state used by `lib/tray/when.ts:evaluateWhen`.
 * Build this once per tray rebuild and pass it to the builder; tests can
 * pass synthetic snapshots without spinning up the real stores.
 */
export interface TrayStateSnapshot {
  goal: {
    active: boolean
    paused: boolean
    /**
     * PII-redacted objective of the open goal (`Goal.safeObjective`), used
     * to label the live status row. Never the raw objective — the tray is an
     * OS surface that can be screenshot, so only the redacted text leaks here.
     */
    title?: string
  }
  automation: { running: boolean; armed: boolean }
  chat: { streaming: boolean; hasActiveSession: boolean }
  platform: { os: "windows" | "macos" | "linux" | "unknown" }
  /** App-level facts surfaced in the status / About sections. */
  app: {
    /** Whether OS-level "launch at login" is currently registered. */
    autostart: boolean
    /** Running app version (`APP_VERSION`), shown in the About submenu. */
    version: string
  }
  /**
   * Desktop-pet quick-glance stats. Optional (added after the original DTO
   * shape shipped) so existing synthetic snapshots in tests don't need
   * updating; absent/`null` when the pet subsystem is disabled
   * (`PetSettings.enabled === false`) or its profile hasn't hatched yet, so
   * tray items gated on `pet.enabled` (see `evaluateWhen`) hide cleanly.
   * Needs are already lazily-decayed (same values the widget shows).
   */
  pet?: { enabled: boolean; energy: number; mood: number; bond: number } | null
}
