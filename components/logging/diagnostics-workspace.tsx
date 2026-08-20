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
 * There are now three channels and the page opens on logs:
 *
 *   logs       the full `LogPanel`, agent-trace enabled
 *   traces     `TraceWorkspace` — trace list → waterfall → span detail
 *   incidents  `IncidentWorkspace` — crash reports, receipts as a filter
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
import {
  AlertTriangleIcon,
  RotateCcwIcon,
  ScrollTextIcon,
  Settings2Icon,
  WaypointsIcon,
} from "lucide-react"

import type { FeatureHeaderAction } from "@/components/feature-shell/feature-page-header"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { IncidentDetail, IncidentWorkspace } from "@/components/logging/incident-workspace"
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
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useDiagnosticConnection } from "@/hooks/diagnostic-service/use-diagnostic-connection"
import { useDiagnosticIncidents } from "@/hooks/logging/use-diagnostic-incidents"
import { useIncidentSubmission } from "@/hooks/logging/use-incident-submission"
import type { DiagnosticIncidentSummary } from "@/hooks/logging/use-diagnostic-incidents"
import { useTransportHealth } from "@/hooks/logging"
import { useEdgeResize, useIsNarrow } from "@/hooks/ui"
import { cn } from "@/lib/utils"
import type { AgentTraceStatsWindow } from "@/lib/observability/trace-window"
import {
  LOG_WORKSPACE_VIEWS,
  resolveLogWorkspaceView,
  useLogWorkspaceStore,
  type LogWorkspaceView,
} from "@/stores/logging/log-workspace-store"

const CHANNEL_ICONS: Record<LogWorkspaceView, typeof ScrollTextIcon> = {
  logs: ScrollTextIcon,
  traces: WaypointsIcon,
  incidents: AlertTriangleIcon,
}

/** Query keys this page owns. `useLogPanelUrlSync` preserves anything it does
 * not own, which is what makes a deep link into a channel survive the log
 * panel's own URL writes. */
const CHANNEL_PARAM = "channel"
const TRACE_PARAM = "traceId"

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
  const traceWindow = useLogWorkspaceStore((state) => state.traceWindow)
  const setTraceWindow = useLogWorkspaceStore((state) => state.setTraceWindow)
  const traceErrorsOnly = useLogWorkspaceStore((state) => state.traceErrorsOnly)
  const setTraceErrorsOnly = useLogWorkspaceStore((state) => state.setTraceErrorsOnly)
  const resetWorkspace = useLogWorkspaceStore((state) => state.resetWorkspace)

  const router = useRouter()
  const incidents = useDiagnosticIncidents()
  // The Incidents channel's consent panel needs a service to submit to; the
  // connection lives with Settings → Diagnostics and is read, not owned, here.
  const diagnosticService = useDiagnosticConnection()
  const submission = useIncidentSubmission({
    connection: diagnosticService.connection,
    accountId: diagnosticService.accountId,
    onChanged: () => incidents.refresh(),
    onConfigure: () => router.push("/settings?section=diagnostics"),
  })
  const { nativeLogging, healthByTransport } = useTransportHealth({
    autoRefresh: true,
    refreshInterval: 5000,
  })
  const narrow = useIsNarrow()

  const [selectedID, setSelectedID] = useState<string | null>(null)
  const [preview, setPreview] = useState<unknown>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DiagnosticIncidentSummary | null>(null)
  // Seeded during render from `?traceId=`; an effect would be a set-state-in-effect.
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(
    () => searchParams?.get(TRACE_PARAM) ?? null
  )
  /** Remount key for the log panel — a cross-channel jump has to re-run the
   * panel's mount-time URL hydration, which is the only way its filter state
   * can be seeded from outside. */
  const [logPanelKey, setLogPanelKey] = useState(0)

  // A `?channel=` deep link wins over the persisted channel, once, at mount.
  // This writes the zustand store rather than local state, so it is a plain
  // side effect and not a set-state-in-effect.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    const channel = searchParams?.get(CHANNEL_PARAM)
    if (channel) setActiveView(resolveLogWorkspaceView(channel))
  }, [searchParams, setActiveView])

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
        trace: params.trace ?? null,
        session: params.session ?? null,
      })
      setLogPanelKey((key) => key + 1)
    },
    [setActiveView]
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
      (selectedID ? filteredIncidents.find((incident) => incident.id === selectedID) : undefined) ??
      filteredIncidents[0] ??
      null,
    [filteredIncidents, selectedID]
  )

  const detailResize = useEdgeResize({
    width: detailWidth,
    min: 280,
    max: 640,
    edge: "left",
    onChange: setDetailWidth,
    onReset: () => setDetailWidth(384),
  })

  const selectIncident = useCallback(
    async (incident: DiagnosticIncidentSummary) => {
      setSelectedID(incident.id)
      setPreviewLoading(true)
      try {
        setPreview(await incidents.read(incident))
      } finally {
        setPreviewLoading(false)
      }
    },
    [incidents]
  )

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    await incidents.remove(deleteTarget)
    if (selectedID === deleteTarget.id) {
      setSelectedID(null)
      setPreview(null)
    }
    setDeleteTarget(null)
  }, [deleteTarget, incidents, selectedID])

  const unhealthyTransports = useMemo(
    () => Object.values(healthByTransport).filter((health) => health.status !== "healthy").length,
    [healthByTransport]
  )
  const transportCount = Object.keys(healthByTransport).length

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
        onSelect: resetWorkspace,
        testId: "logs-reset-workspace",
      },
    ],
    [resetWorkspace, t]
  )

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
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
          <Breadcrumb className="hidden @3xl/feature-header:block">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/">{t("breadcrumbHome")}</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{t("title")}</BreadcrumbPage>
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
                const count = view === "incidents" ? incidents.incidents.length : 0
                return (
                  <TabsTrigger
                    key={view}
                    value={view}
                    aria-label={t(`views.${view}`)}
                    data-testid={`logs-channel-${view}`}
                    className="gap-1.5"
                  >
                    <Icon className="size-4" aria-hidden />
                    <span className="hidden @xl/feature-header:inline">{t(`views.${view}`)}</span>
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
            transportCount={transportCount}
            unhealthyTransports={unhealthyTransports}
            nativeStatus={nativeLogging.status}
            incidentCount={incidents.incidents.length}
          />
        }
        actions={
          <Button asChild variant="ghost" size="sm" className="h-8">
            <Link href="/settings?section=logs">
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
            showTimeline
            includeAgentTrace
            defaultAutoRefresh={false}
            refreshInterval={2000}
            density={density}
            onDensityChange={setDensity}
          />
        ) : activeView === "traces" ? (
          <TraceWorkspace
            window={traceWindow}
            onWindowChange={(next: AgentTraceStatsWindow) => setTraceWindow(next)}
            errorsOnly={traceErrorsOnly}
            onErrorsOnlyChange={setTraceErrorsOnly}
            selectedTraceId={selectedTraceId}
            onSelectTrace={selectTrace}
            onOpenInLogs={(trace) => openInLogs({ trace })}
            onOpenSession={(session) => openInLogs({ session })}
          />
        ) : (
          <IncidentWorkspace
            incidents={filteredIncidents}
            loading={incidents.loading}
            error={incidents.error}
            selected={selectedIncident}
            preview={preview}
            previewLoading={previewLoading}
            activeSource={activeSource}
            incidentStateFilter={incidentStateFilter}
            onSourceChange={setActiveSource}
            onStateChange={setIncidentStateFilter}
            onRefresh={() => void incidents.refresh()}
            onSelect={(incident) => void selectIncident(incident)}
            onDelete={setDeleteTarget}
            detailWidth={detailWidth}
            detailResize={detailResize}
            receiptsOnly={receiptsOnly}
            onReceiptsOnlyChange={setReceiptsOnly}
            submission={submission}
          />
        )}
      </main>

      <Sheet
        open={selectedID !== null && selectedIncident !== null && activeView === "incidents"}
        onOpenChange={(open) => {
          if (!open) setSelectedID(null)
        }}
      >
        <SheetContent
          side={narrow ? "bottom" : "right"}
          className={cn(
            "p-0 xl:hidden",
            narrow ? "h-dvh max-h-dvh" : "w-[min(92vw,560px)] sm:max-w-none"
          )}
          data-testid="incident-detail-drawer"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{t("detail.title")}</SheetTitle>
            <SheetDescription>{t("detail.description")}</SheetDescription>
          </SheetHeader>
          {selectedIncident && (
            <IncidentDetail
              key={selectedIncident.id}
              incident={selectedIncident}
              preview={preview}
              previewLoading={previewLoading}
              onDelete={() => setDeleteTarget(selectedIncident)}
              submission={submission}
            />
          )}
        </SheetContent>
      </Sheet>

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
function WorkspaceHealthPill({
  transportCount,
  unhealthyTransports,
  nativeStatus,
  incidentCount,
}: {
  transportCount: number
  unhealthyTransports: number
  nativeStatus: string
  incidentCount: number
}) {
  const t = useTranslations("logging.workspace.status")

  // Before the first health poll resolves there is nothing to aggregate, and a
  // "0/0" chip reads as a failure rather than as "not measured yet".
  if (transportCount === 0) return null

  const healthyTransports = transportCount - unhealthyTransports
  const nativeNeedsAttention = nativeStatus === "degraded" || nativeStatus === "error"
  const healthy = unhealthyTransports === 0 && !nativeNeedsAttention

  const transportsLabel = t("transports", { healthy: healthyTransports, total: transportCount })
  const nativeLabel = t("native", { status: nativeStatus })
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
          <button
            type="button"
            aria-label={`${transportsLabel} · ${nativeLabel} · ${incidentsLabel}`}
          >
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full", healthy ? "bg-success" : "bg-warning")}
            />
            {`${healthyTransports}/${transportCount}`}
          </button>
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
