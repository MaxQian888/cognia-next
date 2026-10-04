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

import {
  INCIDENT_CLIENT_STATES,
  normalizeIncidentClientState,
  type IncidentClientState,
} from "@/lib/diagnostic-service/types"
import { persistLocalStorage } from "@/stores/persist-storage"
import { useObservabilityStore } from "@/stores/observability/observability-store"
import type { CrashLogLevelFilter, CrashLogSourceFilter } from "@/types/logging"

/**
 * The channels run local → remote:
 *
 * - `diagnostics` (labelled "Errors") is this machine's error-level logger
 *   entries — the in-memory recent-error buffer plus stored error/fatal (and
 *   diagnostic-origin warn) entries — and the native diagnostic snapshot
 *   taken with them. They are *logged* failures, not process crashes; the id
 *   stays `diagnostics` because `?channel=diagnostics` links already exist.
 * - `incidents` (labelled "Crash reports") is the native crash reports this
 *   device captured — Rust panics and minidumps on the desktop, the crash
 *   plugin's reports on mobile — with their consent and submission state.
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
/**
 * The Crash reports channel's lifecycle filter, in the service's own
 * `incident_state` vocabulary (snake_case, `packaged` included). It used to be
 * a camelCase copy without `packaged`, which no stored state could ever match.
 */
export type IncidentStateFilter = "all" | IncidentClientState

export const INCIDENT_STATE_FILTERS: readonly IncidentStateFilter[] = [
  "all",
  ...INCIDENT_CLIENT_STATES,
]

/** Narrow an untrusted value (stale persisted state) to a state filter. */
export function resolveIncidentStateFilter(raw: unknown): IncidentStateFilter {
  if (raw === "all") return "all"
  return normalizeIncidentClientState(raw) ?? "all"
}

const CRASH_SOURCE_FILTERS: readonly CrashLogSourceFilter[] = [
  "all",
  "recent",
  "persisted",
  "diagnostic",
]
const CRASH_LEVEL_FILTERS: readonly CrashLogLevelFilter[] = [
  "all",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]

export const LOG_WORKSPACE_VIEWS: readonly LogWorkspaceView[] = [
  "logs",
  "traces",
  "diagnostics",
  "incidents",
  "service",
]

/**
 * Detail-pane width bounds, shared by every channel with a resizable detail
 * pane (Errors, Crash reports, Service) so a user who widened one meant "detail
 * panes are too narrow", not "this one is".
 */
export const DEFAULT_DETAIL_WIDTH = 384
export const DETAIL_WIDTH_MIN = 280
export const DETAIL_WIDTH_MAX = 640

const DEFAULTS = {
  activeView: "logs" as LogWorkspaceView,
  density: "comfortable" as LogWorkspaceDensity,
  detailWidth: DEFAULT_DETAIL_WIDTH,
  activeSource: "all" as LogWorkspaceSource,
  incidentStateFilter: "all" as IncidentStateFilter,
  /** The former `receipts` view, demoted to a filter on the incidents channel. */
  receiptsOnly: false,
  traceSubView: "explore" as TraceSubView,
  traceErrorsOnly: false,
  /**
   * The Errors channel's filters. They used to be local state in
   * `useCrashLogs`, so switching to another channel and back silently reset
   * them. Source and level persist; the search text lives here for the
   * session only (see `partialize`) — a query restored days later is a list
   * that looks empty for no visible reason.
   */
  crashSource: "all" as CrashLogSourceFilter,
  crashLevel: "all" as CrashLogLevelFilter,
  crashSearch: "",
}

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
  crashSource: CrashLogSourceFilter
  crashLevel: CrashLogLevelFilter
  crashSearch: string
  setActiveView: (view: LogWorkspaceView) => void
  setDensity: (density: LogWorkspaceDensity) => void
  setDetailWidth: (width: number) => void
  setActiveSource: (source: LogWorkspaceSource) => void
  setIncidentStateFilter: (state: IncidentStateFilter) => void
  setReceiptsOnly: (receiptsOnly: boolean) => void
  setTraceSubView: (subView: TraceSubView) => void
  setTraceErrorsOnly: (errorsOnly: boolean) => void
  setCrashSource: (source: CrashLogSourceFilter) => void
  setCrashLevel: (level: CrashLogLevelFilter) => void
  setCrashSearch: (search: string) => void
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
    // v3 persisted the camelCase `awaitingConsent`; v4 speaks the service's
    // `awaiting_consent`. Anything else unrecognized falls back to `all`
    // rather than to a filter nothing can match.
    incidentStateFilter: resolveIncidentStateFilter(raw.incidentStateFilter),
    receiptsOnly: legacy?.receiptsOnly ?? Boolean(raw.receiptsOnly),
    // v2 persisted `traceWindow` ("today" | "week" | "month" | "all"). The
    // channel now shares the dashboard's Grafana-style range, which lives in
    // `stores/observability`, so the field is dropped rather than translated —
    // there is no honest mapping from a calendar-aligned "today" onto a
    // sliding preset.
    traceSubView: resolveTraceSubView(raw.traceSubView as string | undefined),
    traceErrorsOnly: Boolean(raw.traceErrorsOnly),
    crashSource: CRASH_SOURCE_FILTERS.includes(raw.crashSource as CrashLogSourceFilter)
      ? (raw.crashSource as CrashLogSourceFilter)
      : DEFAULTS.crashSource,
    crashLevel: CRASH_LEVEL_FILTERS.includes(raw.crashLevel as CrashLogLevelFilter)
      ? (raw.crashLevel as CrashLogLevelFilter)
      : DEFAULTS.crashLevel,
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
      setCrashSource: (crashSource) => set({ crashSource }),
      setCrashLevel: (crashLevel) => set({ crashLevel }),
      setCrashSearch: (crashSearch) => set({ crashSearch }),
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
      version: 4,
      storage: persistLocalStorage(),
      // Everything but the Errors channel's search text: see `crashSearch`.
      partialize: ({ crashSearch: _crashSearch, ...persisted }) => persisted,
      // The v1 blob carries `activeView: "health"` plus `navigationWidth` /
      // `navigationCollapsed` for a rail that no longer exists. Without this
      // every existing install would rehydrate into a channel that renders
      // nothing. v2 additionally carries `traceWindow`, which the shared
      // Grafana-style range replaced — `migrateLogWorkspace` simply drops it.
      // v3 carries the camelCase `awaitingConsent` state filter, which v4
      // rewrites onto the service vocabulary.
      migrate: (persisted) => migrateLogWorkspace(persisted) as LogWorkspaceState,
    }
  )
)
