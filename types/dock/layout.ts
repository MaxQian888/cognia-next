/**
 * The persisted shape of one dock layout.
 *
 * Scoped by `account + host + contextId` so a chat session, a project and a
 * canvas document each keep their own arrangement, and two accounts on one
 * machine never see each other's. The dockview grid is stored verbatim as its
 * own serialized JSON; everything the app knows that dockview does not —
 * which instance is which panel, which resource it is bound to, where the
 * shell sits — lives beside it.
 */

import type { DockPanelInstance } from "./instance"

/** Which surface owns the dock. One layout namespace per host. */
export type DockHost = "chat" | "project" | "canvas" | "workflow"

/** Which edge of its host the dock occupies. */
export type DockShellEdge = "right" | "left" | "bottom"

export const DOCK_LAYOUT_SCHEMA_VERSION = 1

export interface DockLayoutKey {
  accountId: string
  host: DockHost
  /** Session id, project id or document id — whatever scopes this host. */
  contextId: string
}

/** The dock's own chrome: where it sits and how much room it takes. */
export interface DockShellState {
  edge: DockShellEdge
  /** Percentage of the host container. */
  sizePercent: number
  collapsed: boolean
  /** Collapsed to the 48px activity rail rather than to nothing. */
  railOnly: boolean
}

/**
 * dockview's `SerializedDockview`, held opaquely.
 *
 * Deliberately not typed against dockview's interface: this value is persisted
 * and may be imported from a preset file, so the kernel treats it as untrusted
 * JSON and re-derives every panel `params` from its own instance table rather
 * than trusting what a serialized grid claims. Typing it would invite reading
 * fields straight off it.
 */
export type DockSerializedGrid = Record<string, unknown>

export interface DockLayoutEnvelope {
  schemaVersion: number
  key: DockLayoutKey
  grid: DockSerializedGrid | null
  instances: DockPanelInstance[]
  shell: DockShellState
  /** Monotonic. Every committed mutation bumps it; stale writes are rejected. */
  revision: number
  /** Set when this layout came from a one-way read of a pre-dock store. */
  migratedFrom?: string
  updatedAt: number
}

/** Stable string form of a layout key — the persistence map's key. */
export function dockLayoutKeyOf(key: DockLayoutKey): string {
  return `${key.accountId}::${key.host}::${key.contextId}`
}

export const DEFAULT_DOCK_SHELL_STATE: DockShellState = {
  edge: "right",
  sizePercent: 34,
  collapsed: true,
  railOnly: true,
}

export const DOCK_SHELL_SIZE_BOUNDS = { min: 15, max: 70 } as const

/** Clamp a requested shell size into the range the host can actually render. */
export function clampDockShellSize(sizePercent: number): number {
  if (!Number.isFinite(sizePercent)) return DEFAULT_DOCK_SHELL_STATE.sizePercent
  return Math.min(DOCK_SHELL_SIZE_BOUNDS.max, Math.max(DOCK_SHELL_SIZE_BOUNDS.min, sizePercent))
}
