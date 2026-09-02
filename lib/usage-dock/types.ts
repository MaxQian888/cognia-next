// Contracts shared by the Capacity Dock window, the main window that feeds it,
// and the settings card that configures it (ADR-0165 Phase 2).
//
// Kept separate from the Tauri client so the pure pieces (preference defaults,
// row selection, orientation) can be tested in the node project without a
// Tauri shim.

import type { UsageGlanceSnapshotV1 } from "@/lib/usage/usage-glance"

/** Mirrors the Rust `DockEdge`. `floating` means "not docked". */
export type DockEdge = "left" | "right" | "top" | "bottom" | "floating"

export const DOCK_EDGES: readonly DockEdge[] = ["left", "right", "top", "bottom", "floating"]

/** What the gauge on each row measures. */
export type DockGaugeMode = "quota" | "budget"

/** Rows the expanded rail will show. Mirrors `placement::MAX_VISIBLE_ROWS`. */
export const MAX_DOCK_ROWS = 5

/** Scale bounds. Mirrors `placement::MIN_SCALE` / `MAX_SCALE`. */
export const MIN_DOCK_SCALE = 0.6
export const MAX_DOCK_SCALE = 1.2

/**
 * Renderer-owned dock preferences.
 *
 * Deliberately NOT merged into `TrayDisplayPrefs`. The tray answers "what
 * number do I want glanceable", the dock answers "where does a second window
 * live and which providers does it watch", and folding them together would
 * mean every tray metric change re-placed a window.
 */
export interface UsageDockPreferencesV1 {
  enabled: boolean
  /** Provider ids to show, in order. Empty means "the busiest, automatically". */
  providerIds: string[]
  /** The one row a collapsed rail shows. Falls back to the first provider. */
  preferredProviderId: string | null
  gaugeMode: DockGaugeMode
  edge: DockEdge
  /** Stable monitor identity, or null for the primary display. */
  monitor: string | null
  /** Normalized position along the edge. */
  offset: number
  scale: number
  /** Start expanded rather than collapsing to the preferred row. */
  startExpanded: boolean
  /** Withdraw while a full-screen app owns the dock's display. */
  hideOnFullscreen: boolean
}

export const DEFAULT_USAGE_DOCK_PREFERENCES: UsageDockPreferencesV1 = {
  enabled: false,
  providerIds: [],
  preferredProviderId: null,
  gaugeMode: "budget",
  edge: "right",
  monitor: null,
  offset: 0.5,
  scale: 1,
  startExpanded: false,
  hideOnFullscreen: false,
}

/** Native capability report. Mirrors the Rust `UsageDockCapabilities`. */
export interface UsageDockCapabilities {
  positioning: boolean
  alwaysOnTop: boolean
  globalHover: boolean
  platform: "macos" | "windows" | "linux" | string
  /** i18n leaf under `usageDock.blocked.*` when the dock cannot run here. */
  blockedReason: string | null
}

/** One monitor the dock can be pinned to. Mirrors `UsageDockMonitorInfo`. */
export interface UsageDockMonitor {
  name: string | null
  width: number
  height: number
  scale: number
  isPrimary: boolean
  isPreferred: boolean
}

/** Geometry pushed by Rust after a placement. */
export interface UsageDockGeometry {
  edge: DockEdge
  areaWidth: number
  areaHeight: number
  scale: number
}

/** What the main window pushes to the dock window. */
export interface UsageDockState {
  glance: UsageGlanceSnapshotV1 | null
  preferences: UsageDockPreferencesV1
}

/** One rendered gauge. */
export interface UsageDockRow {
  providerId: string
  /** 0-1, or null when neither a budget nor a quota applies to this provider. */
  ratio: number | null
  /** Already-formatted headline for the row. */
  label: string
  knownCostUsd: number
  unpricedTurns: number
  severity: "ok" | "warn" | "crit" | "exceeded" | "unknown"
}

/** True when the rail runs vertically. */
export function isVerticalEdge(edge: DockEdge): boolean {
  return edge === "left" || edge === "right"
}

/** Clamp a scale into the range Rust also enforces. */
export function clampDockScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_DOCK_SCALE, Math.max(MIN_DOCK_SCALE, scale))
}

/**
 * Merge a stored preference blob onto the defaults.
 *
 * Field-by-field rather than a spread, because a blob written by a newer build
 * (or hand-edited) must not be able to put a value no reader understands into
 * a window placement. Unknown edges and out-of-range scales fall back.
 */
export function mergeDockPreferences(stored: unknown): UsageDockPreferencesV1 {
  const base = { ...DEFAULT_USAGE_DOCK_PREFERENCES }
  if (!stored || typeof stored !== "object") return base
  const raw = stored as Partial<UsageDockPreferencesV1>
  if (typeof raw.enabled === "boolean") base.enabled = raw.enabled
  if (Array.isArray(raw.providerIds)) {
    base.providerIds = raw.providerIds.filter((id): id is string => typeof id === "string")
  }
  if (typeof raw.preferredProviderId === "string" || raw.preferredProviderId === null) {
    base.preferredProviderId = raw.preferredProviderId
  }
  if (raw.gaugeMode === "quota" || raw.gaugeMode === "budget") base.gaugeMode = raw.gaugeMode
  if (typeof raw.edge === "string" && DOCK_EDGES.includes(raw.edge as DockEdge)) {
    base.edge = raw.edge as DockEdge
  }
  if (typeof raw.monitor === "string" || raw.monitor === null) base.monitor = raw.monitor
  if (typeof raw.offset === "number" && Number.isFinite(raw.offset)) {
    base.offset = Math.min(1, Math.max(0, raw.offset))
  }
  if (typeof raw.scale === "number") base.scale = clampDockScale(raw.scale)
  if (typeof raw.startExpanded === "boolean") base.startExpanded = raw.startExpanded
  if (typeof raw.hideOnFullscreen === "boolean") base.hideOnFullscreen = raw.hideOnFullscreen
  return base
}
