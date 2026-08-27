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
 * It is now five channels — **logs / traces / diagnostics / incidents /
 * service** — defaulting to `logs`. `receipts` was never a view, only
 * "incidents that carry a receipt code", so it is a boolean filter on the
 * incidents channel.
 *
 * The Traces channel additionally carries a sub-view (`explore` / `dashboard`)
 * since the standalone `/observability` route folded into it. Only that switch
 * lives here — the range, filters, refresh cadence, thresholds and panel
 * layout it shares with the dashboard stay in `stores/observability`, so a
 * deep link or an imported dashboard config keeps meaning one thing.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"

import { persistLocalStorage } from "@/stores/persist-storage"
import { useObservabilityStore } from "@/stores/observability/observability-store"

/**
 * The channels run local → remote:
 *
 * - `diagnostics` is this machine's crash logs plus the diagnostic snapshot
 *   taken with them. It used to be Settings → Diagnostics → "Crash logs",
 *   which sent the user out of the page named after logs to read the crash
 *   ones; it is a channel here now.
 * - `incidents` is the packaged native crash *reports* awaiting consent.
 * - `service` is the diagnostic service's triage console (ADR-0102). It reads
 *   a remote host rather than local state, which is why it is a channel of its
 *   own rather than a filter on `incidents`: those are the crashes this
 *   machine captured, these are the ones a service accepted from everyone.
 */
export type LogWorkspaceView = "logs" | "traces" | "diagnostics" | "incidents" | "service"

/**
 * The Traces channel's two sub-views. `explore` is the per-trace surface
 * (list → timeline + waterfall → span detail); `dashboard` is the aggregate
 * panel grid that used to be the standalone `/observability` route. They share
 * one time range, one filter set and one Dexie read — see `TraceWorkspace`.
 */
export type TraceSubView = "explore" | "dashboard"

export const TRACE_SUB_VIEWS: readonly TraceSubView[] = ["explore", "dashboard"]

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
  "diagnostics",
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
  traceSubView: "explore" as TraceSubView,
  traceErrorsOnly: false,
}

export const DETAIL_WIDTH_MIN = 280
export const DETAIL_WIDTH_MAX = 640

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

/** Narrow an untrusted value (deep link, stale persisted state) to a sub-view. */
export function resolveTraceSubView(
  raw: string | null | undefined,
  fallback: TraceSubView = DEFAULTS.traceSubView
): TraceSubView {
  return raw !== null && raw !== undefined && (TRACE_SUB_VIEWS as readonly string[]).includes(raw)
    ? (raw as TraceSubView)
    : fallback
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
  traceSubView: TraceSubView
  traceErrorsOnly: boolean
  setActiveView: (view: LogWorkspaceView) => void
  setDensity: (density: LogWorkspaceDensity) => void
  setDetailWidth: (width: number) => void
  setActiveSource: (source: LogWorkspaceSource) => void
  setIncidentStateFilter: (state: IncidentStateFilter) => void
  setReceiptsOnly: (receiptsOnly: boolean) => void
  setTraceSubView: (subView: TraceSubView) => void
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
    // v2 persisted `traceWindow` ("today" | "week" | "month" | "all"). The
    // channel now shares the dashboard's Grafana-style range, which lives in
    // `stores/observability`, so the field is dropped rather than translated —
    // there is no honest mapping from a calendar-aligned "today" onto a
    // sliding preset.
    traceSubView: resolveTraceSubView(raw.traceSubView as string | undefined),
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
      setTraceSubView: (traceSubView) => set({ traceSubView }),
      setTraceErrorsOnly: (traceErrorsOnly) => set({ traceErrorsOnly }),
      resetWorkspace: () => {
        set(DEFAULTS)
        // The Traces channel is only half here. Its range, variable filters,
        // refresh cadence, thresholds, panel layout and deep-link params live
        // in `stores/observability`, so a reset that stopped at this store
        // would leave the user in the view they were trying to escape — and
        // "Reset" is reachable from every channel, including ones where
        // `TraceWorkspace` (and its URL sync) is not mounted to notice.
        useObservabilityStore.getState().resetView()
      },
    }),
    {
      name: "cognia-log-workspace-v1",
      version: 3,
      storage: persistLocalStorage(),
      // The v1 blob carries `activeView: "health"` plus `navigationWidth` /
      // `navigationCollapsed` for a rail that no longer exists. Without this
      // every existing install would rehydrate into a channel that renders
      // nothing. v2 additionally carries `traceWindow`, which the shared
      // Grafana-style range replaced — `migrateLogWorkspace` simply drops it.
      migrate: (persisted) => migrateLogWorkspace(persisted) as LogWorkspaceState,
    }
  )
)
