"use client"

/**
 * `/logs` — the local inspection workspace ADR-0102 consolidates under one
 * route.
 *
 * It used to open on `health`: four hard-coded status cards ("Local capture /
 * ready", "Privacy gate / protected") with no data source behind them, sitting
 * above `recovery` and `advanced`, which were also pure copy. The log panel —
 * the thing the route is named after — was the second of six rail items, and
 * it was mounted with `includeAgentTrace={false}`, which switched off the span
 * merge, the trace view button and the agent-trace stats bar all at once.
 *
 * The channels, in local → remote order, and the page opens on logs:
 *
 *   logs         the full `LogPanel`, agent-trace enabled
 *   traces       `TraceWorkspace` — trace list → waterfall → span detail
 *   diagnostics  `CrashDiagnosticsWorkspace` — this machine's crash logs and
 *                the diagnostic snapshot taken with them. Lifted out of
 *                Settings → Diagnostics, which is where the page named after
 *                logs used to send you to read the crash ones.
 *   incidents    `IncidentWorkspace` — crash reports, receipts as a filter
 *   service      `ServiceConsoleWorkspace` — the diagnostic service's triage
 *                console
 *
 * The status the deleted `health` view gestured at is now a single live chip
 * in the header (see `WorkspaceHealthPill`) reading from `useTransportHealth`,
 * with the settings that control it one click away. The configuration itself
 * stays in Settings → Logs, which already renders the same signals against
 * real data.
 *
 * The header is one row. It used to be two: an identity row and a row holding
 * nothing but three channel tabs and a density select that wrote a store field
 * no stylesheet read — `data-density` only has a reader on `:root`. The tabs
 * moved up (`navigationPlacement="inline"`), and the density control is gone
 * from here because the log panel already owns a working one; the workspace
 * store now feeds that control instead of shadowing it, so the attribute on
 * this element finally matches what the list renders.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ServerIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Settings2Icon,
  WaypointsIcon,
} from "lucide-react"

import type { FeatureHeaderAction } from "@/components/feature-shell/feature-page-header"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { CrashDiagnosticsWorkspace } from "@/components/logging/crash-diagnostics-workspace"
import { IncidentWorkspace } from "@/components/logging/incident-workspace"
import { ServiceConsoleWorkspace } from "@/components/logging/service-console-workspace"
import { LogPanel } from "@/components/logging/log-panel"
import { TraceWorkspace } from "@/components/logging/trace-workspace"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
} from "@/components/ui/breadcrumb"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useDiagnosticConnection } from "@/hooks/diagnostic-service/use-diagnostic-connection"
import {
  countActionableIncidents,
  useDiagnosticIncidents,
} from "@/hooks/logging/use-diagnostic-incidents"
import { useIncidentSubmission } from "@/hooks/logging/use-incident-submission"
import { useTriageConsole } from "@/hooks/diagnostic-service/use-triage-console"
import type { DiagnosticIncidentSummary } from "@/hooks/logging/use-diagnostic-incidents"
import { summarizeTransportHealth, useTransportHealth } from "@/hooks/logging"
import { useEdgeResize } from "@/hooks/ui"
import { cn } from "@/lib/utils"
import { TRACE_URL_KEYS } from "@/lib/observability/url-state"
import {
  DEFAULT_DETAIL_WIDTH,
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  LOG_WORKSPACE_VIEWS,
  resolveLogWorkspaceView,
  resolveTraceSubView,
  useLogWorkspaceStore,
  type LogWorkspaceView,
  type TraceSubView,
} from "@/stores/logging/log-workspace-store"

const CHANNEL_ICONS: Record<LogWorkspaceView, typeof ScrollTextIcon> = {
  logs: ScrollTextIcon,
  traces: WaypointsIcon,
  diagnostics: ActivityIcon,
  incidents: AlertTriangleIcon,
  service: ServerIcon,
}

/** Query keys this page owns. `useLogPanelUrlSync` preserves anything it does
 * not own, which is what makes a deep link into a channel survive the log
 * panel's own URL writes. */
const CHANNEL_PARAM = "channel"
const TRACE_PARAM = "traceId"
/** The Traces sub-view; owned by the Traces channel's URL codec. */
const TRACE_SUB_VIEW_PARAM = TRACE_URL_KEYS.subView
/** The selected crash report, as `<runtime>:<id>`. */
const INCIDENT_PARAM = "incident"
/** The selected group in the Service console. */
const GROUP_PARAM = "group"

/** Where each channel's configuration lives. Logs and Traces are logging
 * policy; the crash channels are the diagnostic service's settings. */
const CONFIGURE_HREF: Record<LogWorkspaceView, string> = {
  logs: "/settings?section=logs",
  traces: "/settings?section=logs",
  diagnostics: "/settings?section=diagnostics",
  incidents: "/settings?section=diagnostics",
  service: "/settings?section=diagnostics",
}

function incidentKey(incident: { runtime: string; id: string }): string {
  return `${incident.runtime}:${incident.id}`
}

/** Replace the page's own params without touching the panel's. Uses
 * `history.replaceState` rather than `router.replace` for the same reason the
 * log panel does: the static export must not re-evaluate the route. */
function writePageParams(next: Record<string, string | null>): void {
  if (typeof window === "undefined") return
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(next)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  try {
    window.history.replaceState(
      {},
      "",
      query ? `${window.location.pathname}?${query}` : window.location.pathname
    )
  } catch {
    // history may be unavailable in sandboxed contexts; state still drives the UI.
  }
}

export function DiagnosticsWorkspace() {
  const t = useTranslations("logging.workspace")
  const searchParams = useSearchParams()

  const activeView = useLogWorkspaceStore((state) => state.activeView)
  const setActiveView = useLogWorkspaceStore((state) => state.setActiveView)
  const density = useLogWorkspaceStore((state) => state.density)
  const setDensity = useLogWorkspaceStore((state) => state.setDensity)
  const detailWidth = useLogWorkspaceStore((state) => state.detailWidth)
  const setDetailWidth = useLogWorkspaceStore((state) => state.setDetailWidth)
  const activeSource = useLogWorkspaceStore((state) => state.activeSource)
  const setActiveSource = useLogWorkspaceStore((state) => state.setActiveSource)
  const incidentStateFilter = useLogWorkspaceStore((state) => state.incidentStateFilter)
  const setIncidentStateFilter = useLogWorkspaceStore((state) => state.setIncidentStateFilter)
  const receiptsOnly = useLogWorkspaceStore((state) => state.receiptsOnly)
  const setReceiptsOnly = useLogWorkspaceStore((state) => state.setReceiptsOnly)
  const traceSubView = useLogWorkspaceStore((state) => state.traceSubView)
  const setTraceSubView = useLogWorkspaceStore((state) => state.setTraceSubView)
  const traceErrorsOnly = useLogWorkspaceStore((state) => state.traceErrorsOnly)
  const setTraceErrorsOnly = useLogWorkspaceStore((state) => state.setTraceErrorsOnly)
  const resetWorkspace = useLogWorkspaceStore((state) => state.resetWorkspace)

  const router = useRouter()
  const incidents = useDiagnosticIncidents()
  // The Incidents channel's consent panel needs a service to submit to; the
  // connection lives with Settings → Diagnostics and is read, not owned, here.
  const diagnosticService = useDiagnosticConnection()
  // Only the Service channel talks to the remote service: mounted at shell
  // level, the console used to send `listGroups` on every `/logs` visit.
  const selectGroup = useCallback((groupId: string | null) => {
    writePageParams({ [GROUP_PARAM]: groupId })
  }, [])
  const triageConsole = useTriageConsole({
    client: diagnosticService.client,
    can: diagnosticService.can,
    enabled: activeView === "service",
    initialSelectedGroupId: searchParams?.get(GROUP_PARAM) ?? null,
    onSelectGroup: selectGroup,
  })
  const submission = useIncidentSubmission({
    connection: diagnosticService.connection,
    accountId: diagnosticService.accountId,
    onChanged: () => incidents.refresh(),
    onConfigure: () => router.push("/settings?section=diagnostics"),
  })
  // One poll for the page: the header chip and the Logs channel's transport
  // tiles used to run two (5 s and 2 s) and could disagree. The panel takes
  // this one via `transportHealth` and starts none of its own.
  const transportHealth = useTransportHealth({
    autoRefresh: true,
    refreshInterval: 2000,
  })
  const { nativeLogging, healthByTransport } = transportHealth

  // `<runtime>:<id>`, seeded from `?incident=` so a crash report is linkable.
  const [selectedID, setSelectedID] = useState<string | null>(
    () => searchParams?.get(INCIDENT_PARAM) ?? null
  )
  // The preview is keyed by the incident it was read for. It used to be one
  // slot filled by the last click, so an auto-selected first incident showed
  // "No preview", and filtering the clicked one away showed the next incident
  // beside the previous one's preview — with Submit enabled for it.
  const [previewState, setPreviewState] = useState<{
    key: string
    value: unknown
    error: boolean
  } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DiagnosticIncidentSummary | null>(null)
  // Seeded during render from `?traceId=`; an effect would be a set-state-in-effect.
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(
    () => searchParams?.get(TRACE_PARAM) ?? null
  )
  /** Remount key for the log panel — a cross-channel jump has to re-run the
   * panel's mount-time URL hydration, which is the only way its filter state
   * can be seeded from outside. */
  const [logPanelKey, setLogPanelKey] = useState(0)
  const compact = useCompactLayout()

  // A `?channel=` deep link wins over the persisted channel. Without one, the
  // persisted channel is restored — and written into the URL, so "copy link"
  // and a reload-then-share hand the next person the channel on screen.
  //
  // This re-runs whenever the query changes, not just at mount: an in-app link
  // to `/logs?channel=…` (the cost-budget notification, Performance → Open
  // trace dashboard) while `/logs` is already open changed the address bar and
  // nothing else. Our own `replaceState` writes come back through here too;
  // they carry the values already on screen, so adopting them is a no-op.
  // These write zustand stores, not local state, so they are plain side
  // effects rather than set-state-in-effect.
  const searchKey = searchParams?.toString() ?? ""
  const hydratedRef = useRef(false)
  useEffect(() => {
    const firstRun = !hydratedRef.current
    hydratedRef.current = true
    const params = new URLSearchParams(searchKey)
    const channel = params.get(CHANNEL_PARAM)
    const store = useLogWorkspaceStore.getState()
    if (channel) {
      const view = resolveLogWorkspaceView(channel)
      if (view !== store.activeView) setActiveView(view)
    } else if (firstRun && store.activeView !== "logs") {
      writePageParams({ [CHANNEL_PARAM]: store.activeView })
    }
    const subView = params.get(TRACE_SUB_VIEW_PARAM)
    if (subView) {
      const next = resolveTraceSubView(subView)
      if (next !== store.traceSubView) setTraceSubView(next)
    }
  }, [searchKey, setActiveView, setTraceSubView])

  // `?traceId=` / `?incident=` adopted on in-app navigation, during render
  // (the "adjust state when a prop changes" pattern). `seen*` is what the URL
  // last said, never what we wrote, so a stale hook value cannot undo a click.
  const traceParam = searchParams?.get(TRACE_PARAM) ?? null
  const [seenTraceParam, setSeenTraceParam] = useState(traceParam)
  if (traceParam !== seenTraceParam) {
    setSeenTraceParam(traceParam)
    setSelectedTraceId(traceParam)
  }
  const incidentParam = searchParams?.get(INCIDENT_PARAM) ?? null
  const [seenIncidentParam, setSeenIncidentParam] = useState(incidentParam)
  if (incidentParam !== seenIncidentParam) {
    setSeenIncidentParam(incidentParam)
    if (incidentParam) setSelectedID(incidentParam)
  }

  /** The Traces sub-view, mirrored into `?tview=` (explore is the default
   * and stays out of the URL). Tabs, the `v` shortcut and dashboard
   * drill-downs all come through here. */
  const changeTraceSubView = useCallback(
    (next: TraceSubView) => {
      setTraceSubView(next)
      writePageParams({ [TRACE_SUB_VIEW_PARAM]: next === "explore" ? null : next })
    },
    [setTraceSubView]
  )

  const selectChannel = useCallback(
    (view: LogWorkspaceView) => {
      setActiveView(view)
      writePageParams({ [CHANNEL_PARAM]: view === "logs" ? null : view })
    },
    [setActiveView]
  )

  const selectTrace = useCallback((traceId: string | null) => {
    setSelectedTraceId(traceId)
    writePageParams({ [TRACE_PARAM]: traceId })
  }, [])

  /** Traces → Logs. Writes the panel's own `trace` / `session` params and
   * remounts it so its mount-time hydration picks them up. */
  const openInLogs = useCallback(
    (params: { trace?: string; session?: string }) => {
      setActiveView("logs")
      writePageParams({
        [CHANNEL_PARAM]: null,
        [TRACE_PARAM]: null,
        [TRACE_SUB_VIEW_PARAM]: null,
        trace: params.trace ?? null,
        session: params.session ?? null,
      })
      setLogPanelKey((key) => key + 1)
    },
    [setActiveView]
  )

  /** Logs → Traces: the detail pane's "Open in Traces" on an agent-trace
   * entry. The reverse of `openInLogs`; the explore sub-view is the one with a
   * waterfall to land on. */
  const openTrace = useCallback(
    (traceId: string) => {
      setTraceSubView("explore")
      setActiveView("traces")
      setSelectedTraceId(traceId)
      writePageParams({
        [CHANNEL_PARAM]: "traces",
        [TRACE_PARAM]: traceId,
        [TRACE_SUB_VIEW_PARAM]: null,
      })
    },
    [setActiveView, setTraceSubView]
  )

  const filteredIncidents = useMemo(
    () =>
      incidents.incidents.filter(
        (incident) =>
          (activeSource === "all" || incident.runtime === activeSource) &&
          (incidentStateFilter === "all" || incident.state === incidentStateFilter) &&
          (!receiptsOnly || Boolean(incident.receiptCode))
      ),
    [activeSource, incidentStateFilter, receiptsOnly, incidents.incidents]
  )
  const selectedIncident = useMemo(
    () =>
      (selectedID
        ? filteredIncidents.find((incident) => incidentKey(incident) === selectedID)
        : undefined) ??
      filteredIncidents[0] ??
      null,
    [filteredIncidents, selectedID]
  )
  const selectedIncidentKey = selectedIncident ? incidentKey(selectedIncident) : null

  // Read the preview for whichever incident is on screen — clicked, deep
  // linked or auto-selected — and drop a response for one no longer shown.
  // State is only set in the promise callbacks.
  const readIncident = incidents.read
  useEffect(() => {
    if (!selectedIncident || !selectedIncidentKey) return
    let cancelled = false
    readIncident(selectedIncident).then(
      (value) => {
        if (!cancelled) setPreviewState({ key: selectedIncidentKey, value, error: false })
      },
      () => {
        if (!cancelled) setPreviewState({ key: selectedIncidentKey, value: null, error: true })
      }
    )
    return () => {
      cancelled = true
    }
    // `selectedIncident` is identified by its key; a new object for the same
    // report must not re-read it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readIncident, selectedIncidentKey])
  const previewCurrent = previewState !== null && previewState.key === selectedIncidentKey
  const preview = previewCurrent ? previewState.value : null
  const previewLoading = selectedIncidentKey !== null && !previewCurrent

  const detailResize = useEdgeResize({
    width: detailWidth,
    min: DETAIL_WIDTH_MIN,
    max: DETAIL_WIDTH_MAX,
    edge: "left",
    onChange: setDetailWidth,
    onReset: () => setDetailWidth(DEFAULT_DETAIL_WIDTH),
  })

  const selectIncident = useCallback((incident: DiagnosticIncidentSummary) => {
    const key = incidentKey(incident)
    setSelectedID(key)
    writePageParams({ [INCIDENT_PARAM]: key })
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await incidents.remove(deleteTarget)
      if (selectedID === incidentKey(deleteTarget)) {
        setSelectedID(null)
        writePageParams({ [INCIDENT_PARAM]: null })
      }
      toast.success(t("delete.done"))
    } catch (error) {
      toast.error(
        t("delete.failed", { error: error instanceof Error ? error.message : String(error) })
      )
    } finally {
      setDeleteTarget(null)
    }
  }, [deleteTarget, incidents, selectedID, t])

  const actionableIncidents = useMemo(
    () => countActionableIncidents(incidents.incidents),
    [incidents.incidents]
  )
  // The same denominator the panel's chip shows — including the native
  // pipeline on the desktop — so the header can no longer read 4/4 while the
  // chip below reads 4/5.
  const healthSummary = useMemo(
    () => summarizeTransportHealth(healthByTransport, nativeLogging),
    [healthByTransport, nativeLogging]
  )

  /** "Reset layout" is a rare, whole-page action that used to sit in the
   * header as a labelled button competing with Configure. It lives in the
   * overflow menu now — the row it vacated is what let the channel tabs move
   * up into the identity row. */
  const overflowActions = useMemo<FeatureHeaderAction[]>(
    () => [
      {
        id: "reset-workspace",
        label: t("reset"),
        icon: RotateCcwIcon,
        // The store reset returns to the Logs channel; the URL has to follow
        // or a reload reopens the channel that was just reset away from.
        onSelect: () => {
          resetWorkspace()
          writePageParams({
            [CHANNEL_PARAM]: null,
            [TRACE_PARAM]: null,
            [TRACE_SUB_VIEW_PARAM]: null,
            [INCIDENT_PARAM]: null,
            [GROUP_PARAM]: null,
          })
          setSelectedTraceId(null)
          setSelectedID(null)
        },
        testId: "logs-reset-workspace",
      },
    ],
    [resetWorkspace, t]
  )

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
      data-bg-target="chat"
      data-testid="diagnostics-workspace"
      data-density={density}
      data-channel={activeView}
    >
      <FeaturePageHeader
        variant="compact"
        testId="logs-page-header"
        icon={<ScrollTextIcon />}
        title={t("title")}
        breadcrumb={
          // Just the way back. The trail's last crumb was `t("title")`, and
          // the header prints `t("title")` as the heading immediately to its
          // right, so a wide window read "Home > Logs and diagnostics" and
          // then "Logs and diagnostics" again. A crumb that repeats the
          // heading beside it is chrome, not orientation.
          <Breadcrumb className="hidden @3xl/feature-header:block">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/">{t("breadcrumbHome")}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        }
        navigationPlacement="inline"
        navigation={
          <Tabs
            value={activeView}
            onValueChange={(value) => selectChannel(value as LogWorkspaceView)}
          >
            <TabsList aria-label={t("navigation.label")} className="h-8">
              {LOG_WORKSPACE_VIEWS.map((view) => {
                const Icon = CHANNEL_ICONS[view]
                // The incident count used to sit in the header status strip,
                // one row above the tab it describes. It belongs on the tab:
                // the number and the thing it counts are now the same target.
                // Only reports waiting on the user: one with a receipt is the
                // service's to process, and counting it kept the badge lit
                // forever after every report had been sent.
                const count = view === "incidents" ? actionableIncidents : 0
                return (
                  <TabsTrigger
                    key={view}
                    value={view}
                    aria-label={t(`views.${view}`)}
                    // The icon-only width below still needs a way to read
                    // the tab; the label shows once the header can fit it.
                    title={`${t(`views.${view}`)} — ${t(`viewDescriptions.${view}`)}`}
                    data-testid={`logs-channel-${view}`}
                    className="gap-1.5"
                  >
                    <Icon className="size-4" aria-hidden />
                    {/* Labels from @5xl, not @xl: with them the tab strip is
                        ~470px, and at @xl..@5xl it crushed the page title
                        beside it to a clipped "Logs ar / diagno.". */}
                    <span
                      className="hidden @5xl/feature-header:inline"
                      data-testid={`logs-channel-${view}-label`}
                    >
                      {t(`views.${view}`)}
                    </span>
                    {count > 0 ? (
                      <Badge
                        variant="secondary"
                        className="h-4 min-w-4 justify-center px-1 font-mono text-[10px] tabular-nums"
                        data-testid="logs-channel-incidents-count"
                      >
                        {count}
                      </Badge>
                    ) : null}
                  </TabsTrigger>
                )
              })}
            </TabsList>
          </Tabs>
        }
        status={
          <WorkspaceHealthPill
            healthy={healthSummary.healthy}
            total={healthSummary.total}
            nativeNeedsAttention={healthSummary.nativeNeedsAttention}
            nativeStatus={nativeLogging.status}
            incidentCount={actionableIncidents}
          />
        }
        actions={
          <Button asChild variant="ghost" size="sm" className="h-8">
            <Link href={CONFIGURE_HREF[activeView]} data-testid="logs-configure">
              <Settings2Icon className="size-4" />
              <span className="hidden @2xl/feature-header:inline">{t("configure")}</span>
            </Link>
          </Button>
        }
        overflowLabel={t("moreActions")}
        overflowActions={overflowActions}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t">
        {activeView === "logs" ? (
          <LogPanel
            key={logPanelKey}
            showStats
            // The timeline is a histogram of log volume over time. At 375px it
            // is a few pixels per bucket above the list it is meant to explain,
            // so it costs vertical space on the screen with the least of it and
            // reads as noise. The stats bar carries the same counts as numbers.
            showTimeline={!compact}
            includeAgentTrace
            defaultAutoRefresh={false}
            refreshInterval={2000}
            density={density}
            onDensityChange={setDensity}
            onOpenTrace={openTrace}
            transportHealth={transportHealth}
          />
        ) : activeView === "traces" ? (
          <TraceWorkspace
            subView={traceSubView}
            onSubViewChange={changeTraceSubView}
            errorsOnly={traceErrorsOnly}
            onErrorsOnlyChange={setTraceErrorsOnly}
            selectedTraceId={selectedTraceId}
            onSelectTrace={selectTrace}
            onOpenInLogs={(trace) => openInLogs({ trace })}
            onOpenSession={(session) => openInLogs({ session })}
          />
        ) : activeView === "diagnostics" ? (
          <CrashDiagnosticsWorkspace />
        ) : activeView === "service" ? (
          <ServiceConsoleWorkspace
            console={triageConsole}
            configured={Boolean(diagnosticService.connection)}
            authenticated={diagnosticService.authenticated}
            loading={diagnosticService.loading}
            roleStatus={diagnosticService.roleStatus}
            roleErrorCode={diagnosticService.roleErrorCode}
            onRetryRole={diagnosticService.probeRole}
            can={diagnosticService.can}
            onConfigure={() => router.push("/settings?section=diagnostics")}
          />
        ) : (
          <IncidentWorkspace
            incidents={filteredIncidents}
            loading={incidents.loading}
            error={incidents.error}
            selected={selectedIncident}
            preview={preview}
            previewLoading={previewLoading}
            runtimes={incidents.runtimes}
            activeSource={activeSource}
            incidentStateFilter={incidentStateFilter}
            onSourceChange={setActiveSource}
            onStateChange={setIncidentStateFilter}
            onRefresh={() => void incidents.refresh()}
            onSelect={selectIncident}
            onDelete={setDeleteTarget}
            detailWidth={detailWidth}
            detailResize={detailResize}
            receiptsOnly={receiptsOnly}
            onReceiptsOnlyChange={setReceiptsOnly}
            submission={submission}
          />
        )}
      </main>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("delete.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("delete.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t("delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * The live replacement for the deleted `health` view, and the whole of it.
 *
 * This was three badges — transports, native-log readiness, retained
 * incidents — sitting side by side in the header while the log panel rendered
 * the same transport health again as clickable tiles two rows below, and the
 * incident count again as the channel the user was looking at. Three facts,
 * six renderings.
 *
 * Now it is one chip carrying the aggregate, with the breakdown on hover and
 * in its accessible name. The incident count moved onto the Incidents tab; the
 * per-transport detail stays on the log panel's tiles, which can actually be
 * clicked through to a filtered view. Tone follows the worst of the two
 * signals, so a degraded native pipeline still turns the chip amber even when
 * every transport is healthy.
 */
/** Settings → Logs, opened on the Overview panel (`LOGS_PANEL_PARAM`). */
export const HEALTH_DETAILS_HREF = "/settings?section=logs&logsPanel=overview"

function WorkspaceHealthPill({
  healthy: healthyCount,
  total,
  nativeNeedsAttention,
  nativeStatus,
  incidentCount,
}: {
  healthy: number
  total: number
  nativeNeedsAttention: boolean
  nativeStatus: string
  incidentCount: number
}) {
  const t = useTranslations("logging.workspace.status")
  const tNative = useTranslations("logging.crash.native.statuses")

  // Before the first health poll resolves there is nothing to aggregate, and a
  // "0/0" chip reads as a failure rather than as "not measured yet".
  if (total === 0) return null

  const healthy = healthyCount === total && !nativeNeedsAttention

  const transportsLabel = t("transports", { healthy: healthyCount, total })
  const nativeLabel = t("native", {
    status: tNative.has(nativeStatus) ? tNative(nativeStatus) : nativeStatus,
  })
  const incidentsLabel = t("incidents", { count: incidentCount })

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          asChild
          variant="outline"
          data-testid="logs-status-strip"
          data-health={healthy ? "healthy" : "attention"}
          className={cn(
            "gap-1.5 font-mono text-[11px] tabular-nums",
            !healthy && "border-warning/50 text-warning"
          )}
        >
          {/* A link, not a dead button: the breakdown it summarizes — every
              transport, native readiness, the problem list — is Settings →
              Logs → Overview, which is what "one click away" promised. */}
          <Link
            href={HEALTH_DETAILS_HREF}
            aria-label={`${transportsLabel} · ${nativeLabel} · ${incidentsLabel}`}
          >
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", healthy ? "bg-success" : "bg-warning")}
            />
            {`${healthyCount}/${total}`}
          </Link>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="space-y-0.5">
        <div>{transportsLabel}</div>
        <div>{nativeLabel}</div>
        <div>{incidentsLabel}</div>
      </TooltipContent>
    </Tooltip>
  )
}

export default DiagnosticsWorkspace
