// Shared types for the system-tray client. These mirror the serde DTOs in
// `src-tauri/src/tray/dto.rs`; keep the two in lockstep when extending the
// menu schema.

import type { LimitsMeterKind, LimitsMeterStatus } from "@/types/subscription"

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
  /**
   * Subscription-quota glance data (ADR-0025 unified limits), populated by
   * `lib/tray/usage.ts:useTrayUsage` only while at least one tray usage
   * surface (menu section / tooltip suffix / taskbar mode) is enabled.
   * Absent/`null` keeps existing synthetic snapshots valid and hides every
   * usage surface cleanly.
   */
  usage?: TrayUsageSnapshot | null
}

/**
 * Compact projection of one `LimitsMeter` (`types/subscription/limits.ts`)
 * carrying only what a tray row / badge / tooltip needs. Numbers stay raw —
 * formatting happens in `lib/tray/usage.ts` so every surface renders the
 * same text.
 */
export interface TrayUsageMeterSummary {
  id: string
  /** i18n key under `subscription.limits.meter.*` (resolved by the resilient translator). */
  labelKey?: string
  /** Literal label for custom sources (passed through the resilient translator). */
  label?: string
  kind: LimitsMeterKind
  usedPct: number | null
  status: LimitsMeterStatus
  resetAt?: number | null
  remaining?: number
  unit?: string
  currency?: string
}

/** One configured subscription account's quota glance. */
export interface TrayUsageAccount {
  /** Stable selection key — `provider:accountId` (or `provider:label` for custom sources). */
  key: string
  provider: string
  accountLabel?: string
  /** Highest-utilization meter — what compact surfaces (badge / title / tooltip) show. */
  worst: TrayUsageMeterSummary | null
  meters: TrayUsageMeterSummary[]
  /** Present when the last refresh failed for this account. */
  error?: string
}

/** Aggregated usage snapshot flowing through `TrayStateSnapshot.usage`. */
export interface TrayUsageSnapshot {
  accounts: TrayUsageAccount[]
  /** Newest `fetchedAt` across accounts; `null` before the first refresh lands. */
  fetchedAt: number | null
  /** The account pinned to compact surfaces, or `null` for "worst across all". */
  selectedKey: string | null
}

/** Where the compact usage readout surfaces outside the menu. */
export type TrayTaskbarUsageMode = "off" | "iconBadge" | "title"

/**
 * User-tunable tray display preferences, persisted under
 * `TRAY_DISPLAY_PREF` (`lib/tray/defaults.ts`) alongside the layout.
 */
export interface TrayDisplayPrefs {
  /** Expand the `tray.usage` placeholder into the subscription-quota section. */
  showUsageInMenu: boolean
  /** Append the compact usage readout to the OS tooltip. */
  showUsageInTooltip: boolean
  /**
   * Taskbar-adjacent readout: `iconBadge` rasterizes the percent onto the
   * tray icon (all platforms), `title` sets the text next to the icon via
   * `tray_set_title` (macOS menu bar; Linux appindicator; Windows no-op).
   */
  taskbarUsageMode: TrayTaskbarUsageMode
  /** Pinned subscription (`TrayUsageAccount.key`) or `null` = worst across all. */
  usageAccountKey: string | null
  /** Auto-refresh cadence in minutes; `0` = manual refresh only. */
  usageRefreshMinutes: number
  /** Stroke color for the rasterized tray icons (ignored by macOS template mode). */
  iconColor: string
}
