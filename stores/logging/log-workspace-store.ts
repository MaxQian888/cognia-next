"use client"

/**
 * Device-local layout + filter preferences for the `/logs` workspace.
 *
 * The workspace used to have six peer views (`health / logs / incidents /
 * receipts / recovery / advanced`) and opened on `health` — four hard-coded
 * status cards with no data source — so the page named "Logs" showed no logs
 * until you clicked. Three of those views were pure copy; the real status they
 * gestured at (transport health, native-log readiness, queue depth) has a
 * live implementation in Settings → Logs → Overview.
 *
 * It is now three channels — **logs / traces / incidents** — defaulting to
 * `logs`. `receipts` was never a view, only "incidents that carry a receipt
 * code", so it is a boolean filter on the incidents channel.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"
import type { AgentTraceStatsWindow } from "@/lib/observability/trace-window"
import { resolveAgentTraceWindow } from "@/lib/observability/trace-window"

/**
 * `service` is the diagnostic service's triage console (ADR-0102). It reads a
 * remote host rather than local state, which is why it is a channel of its own
 * rather than a filter on `incidents`: those are the crashes this machine
 * captured, these are the ones a service accepted from everyone.
 */
export type LogWorkspaceView = "logs" | "traces" | "incidents" | "service"
export type LogWorkspaceDensity = "compact" | "comfortable" | "spacious"
export type LogWorkspaceSource = "all" | "desktop" | "mobile"
export type IncidentStateFilter =
  | "all"
  | "detected"
  | "awaitingConsent"
  | "queued"
  | "uploading"
  | "processing"
  | "accepted"
  | "rejected"
  | "cancelled"
  | "deleted"

export const LOG_WORKSPACE_VIEWS: readonly LogWorkspaceView[] = [
  "logs",
  "traces",
  "incidents",
  "service",
]

const DEFAULTS = {
  activeView: "logs" as LogWorkspaceView,
  density: "comfortable" as LogWorkspaceDensity,
  detailWidth: 384,
  activeSource: "all" as LogWorkspaceSource,
  incidentStateFilter: "all" as IncidentStateFilter,
  /** The former `receipts` view, demoted to a filter on the incidents channel. */
  receiptsOnly: false,
  traceWindow: "today" as AgentTraceStatsWindow,
  traceErrorsOnly: false,
}

export const DETAIL_WIDTH_MIN = 280
export const DETAIL_WIDTH_MAX = 640

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Narrow an untrusted value (deep link, stale persisted state) to a channel. */
export function resolveLogWorkspaceView(
  raw: string | null | undefined,
  fallback: LogWorkspaceView = DEFAULTS.activeView
): LogWorkspaceView {
  return raw !== null &&
    raw !== undefined &&
    (LOG_WORKSPACE_VIEWS as readonly string[]).includes(raw)
    ? (raw as LogWorkspaceView)
    : fallback
}

interface LogWorkspaceState {
  activeView: LogWorkspaceView
  density: LogWorkspaceDensity
  detailWidth: number
  activeSource: LogWorkspaceSource
  incidentStateFilter: IncidentStateFilter
  receiptsOnly: boolean
  traceWindow: AgentTraceStatsWindow
  traceErrorsOnly: boolean
  setActiveView: (view: LogWorkspaceView) => void
  setDensity: (density: LogWorkspaceDensity) => void
  setDetailWidth: (width: number) => void
  setActiveSource: (source: LogWorkspaceSource) => void
  setIncidentStateFilter: (state: IncidentStateFilter) => void
  setReceiptsOnly: (receiptsOnly: boolean) => void
  setTraceWindow: (window: AgentTraceStatsWindow) => void
  setTraceErrorsOnly: (errorsOnly: boolean) => void
  resetWorkspace: () => void
}

/**
 * v1 persisted `activeView` values that no longer exist. `health`, `recovery`
 * and `advanced` were static copy, so anyone parked on them wanted the page's
 * actual subject: logs. `receipts` becomes `incidents` + `receiptsOnly`.
 */
const LEGACY_VIEWS: Record<string, { activeView: LogWorkspaceView; receiptsOnly?: boolean }> = {
  health: { activeView: "logs" },
  recovery: { activeView: "logs" },
  advanced: { activeView: "logs" },
  receipts: { activeView: "incidents", receiptsOnly: true },
}

/** Exported for the store's unit test — persist's `migrate` is otherwise only
 * reachable through a real rehydration. */
export function migrateLogWorkspace(persisted: unknown): Partial<LogWorkspaceState> {
  if (typeof persisted !== "object" || persisted === null) return {}
  const raw = persisted as Record<string, unknown>
  const legacy = typeof raw.activeView === "string" ? LEGACY_VIEWS[raw.activeView] : undefined

  return {
    activeView: legacy?.activeView ?? resolveLogWorkspaceView(raw.activeView as string | undefined),
    density: (["compact", "comfortable", "spacious"] as const).includes(
      raw.density as LogWorkspaceDensity
    )
      ? (raw.density as LogWorkspaceDensity)
      : DEFAULTS.density,
    detailWidth:
      typeof raw.detailWidth === "number"
        ? clamp(raw.detailWidth, DETAIL_WIDTH_MIN, DETAIL_WIDTH_MAX)
        : DEFAULTS.detailWidth,
    activeSource: (["all", "desktop", "mobile"] as const).includes(
      raw.activeSource as LogWorkspaceSource
    )
      ? (raw.activeSource as LogWorkspaceSource)
      : DEFAULTS.activeSource,
    incidentStateFilter:
      typeof raw.incidentStateFilter === "string"
        ? (raw.incidentStateFilter as IncidentStateFilter)
        : DEFAULTS.incidentStateFilter,
    receiptsOnly: legacy?.receiptsOnly ?? Boolean(raw.receiptsOnly),
    traceWindow: resolveAgentTraceWindow(raw.traceWindow as string | undefined),
    traceErrorsOnly: Boolean(raw.traceErrorsOnly),
  }
}

export const useLogWorkspaceStore = create<LogWorkspaceState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setActiveView: (activeView) => set({ activeView }),
      setDensity: (density) => set({ density }),
      setDetailWidth: (detailWidth) =>
        set({ detailWidth: clamp(detailWidth, DETAIL_WIDTH_MIN, DETAIL_WIDTH_MAX) }),
      setActiveSource: (activeSource) => set({ activeSource }),
      setIncidentStateFilter: (incidentStateFilter) => set({ incidentStateFilter }),
      setReceiptsOnly: (receiptsOnly) => set({ receiptsOnly }),
      setTraceWindow: (traceWindow) => set({ traceWindow }),
      setTraceErrorsOnly: (traceErrorsOnly) => set({ traceErrorsOnly }),
      resetWorkspace: () => set(DEFAULTS),
    }),
    {
      name: "cognia-log-workspace-v1",
      version: 2,
      storage: persistLocalStorage(),
      // The v1 blob carries `activeView: "health"` plus `navigationWidth` /
      // `navigationCollapsed` for a rail that no longer exists. Without this
      // every existing install would rehydrate into a channel that renders
      // nothing.
      migrate: (persisted) => migrateLogWorkspace(persisted) as LogWorkspaceState,
    }
  )
)
