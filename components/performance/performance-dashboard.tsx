"use client"

/**
 * Capability-driven diagnostic workspace. Renderer data is always available
 * in authenticated full shells; selected-host resources progressively appear
 * when the active transport advertises them.
 *
 * The four tabs answer four questions, in the order a user asks them:
 *
 *   Overview   how is it doing right now — per-source metric rail + graph
 *   Diagnose   where is the time going — host span hotspots, renderer
 *              timings, and the evidence about the measurement itself
 *              (sources, capabilities, gaps, overhead)
 *   Resources  what is running — processes, async runtime, managed
 *              processes, system facts
 *   Captures   record, compare and budget-check evidence over time
 *
 * Tab and section live in the URL (`lib/perf/dashboard-url.ts`), so the
 * status-bar capture chip can land on Captures and a link can point at
 * Processes. Host-only sections explain why they are empty
 * (`PerfHostUnavailable`) instead of rendering as disabled tabs.
 */

import { useCallback, useState, useSyncExternalStore } from "react"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import Link from "next/link"
import {
  ActivityIcon,
  BoxesIcon,
  CameraIcon,
  CpuIcon,
  ScrollTextIcon,
  StethoscopeIcon,
  WaypointsIcon,
} from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { usePerfStream } from "@/hooks/perf/use-perf-stream"
import { exportPerfSnapshot, type PerfExportFormat } from "@/lib/perf/backend/export"
import { perfResetHotspots } from "@/lib/perf/backend/commands"
import { getPerformanceCaptureController } from "@/lib/perf/capture-controller"
import {
  parsePerfDashboardParams,
  writePerfDashboardParams,
  type PerfDashboardTab,
  type PerfDashboardUrlState,
  type PerfResourceSection,
} from "@/lib/perf/dashboard-url"
import type { PerfMetricId } from "@/lib/perf/metric-catalog"
import { getRendererPerformanceCollector } from "@/lib/perf/renderer-collector"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { PerfLiveStatus, PerfToolbar } from "./perf-toolbar"
import { PerfOverviewTab } from "./perf-overview-tab"
import { PerfProcessTable } from "./perf-process-table"
import { PerfManagedProcesses } from "./perf-managed-processes"
import { PerfHotspotsTable } from "./perf-hotspots-table"
import { PerfRuntimeTab } from "./perf-runtime-tab"
import { PerfSystemTab } from "./perf-system-tab"
import { PerfSourceHealth, PerfSourceNotice } from "./perf-source-health"
import { PerfCapturesTab } from "./perf-captures-tab"
import { PerfHostUnavailable } from "./perf-host-unavailable"
import { PerfRendererTimingsTable } from "./perf-renderer-timings-table"
import { PerfWebVitalsPanel } from "./perf-web-vitals-panel"
import { PerfBrowserDiagnostics } from "./perf-browser-diagnostics"
import { PerfOperationTimings } from "./perf-operation-timings"

/** Where the trace dashboard lives (`/logs` → Traces → Dashboard). */
export const PERF_TRACE_DASHBOARD_HREF = "/logs?channel=traces&tview=dashboard"

const captureController = getPerformanceCaptureController()
const captureSnapshot = () => captureController.snapshot

const rendererCollector = getRendererPerformanceCollector()
const readRendererMeasurements = () => rendererCollector.getMeasurements()
const clearRendererMeasurements = () => rendererCollector.clearMeasurements()

export function PerformanceDashboard() {
  const t = useTranslations("performance")
  const searchParams = useSearchParams()
  const {
    history,
    latest,
    rendererHistory,
    hostHistory,
    sources,
    gaps,
    hostState,
    error,
    hostIssue,
    paused,
    intervalMs,
    setPaused,
    setIntervalMs,
    reset,
  } = usePerfStream()
  const capture = useSyncExternalStore(
    captureController.subscribe.bind(captureController),
    captureSnapshot,
    captureSnapshot
  )

  // URL-backed view state. Seeded from the query, adopted again whenever the
  // query changes underneath us (an in-app link to `/performance?tab=…`
  // while the page is mounted), and written in place on every change. The
  // adopt step happens during render — the "adjust state when a prop
  // changes" pattern — rather than in an effect.
  //
  // `seenKey` is the query as `useSearchParams` last reported it, never the
  // one we wrote: whether (and when) Next reflects a `replaceState` back
  // through the hook is not ours to rely on, and comparing against our own
  // write made a stale hook value look like navigation and undo the click.
  const searchKey = searchParams?.toString() ?? ""
  const [urlSync, setUrlSync] = useState(() => ({
    seenKey: searchKey,
    state: parsePerfDashboardParams(searchParams),
  }))
  let view = urlSync.state
  if (urlSync.seenKey !== searchKey) {
    view = parsePerfDashboardParams(searchParams)
    setUrlSync({ seenKey: searchKey, state: view })
  }
  const updateView = useCallback((patch: Partial<PerfDashboardUrlState>) => {
    writePerfDashboardParams(patch)
    setUrlSync((previous) => ({ ...previous, state: { ...previous.state, ...patch } }))
  }, [])
  const openTab = useCallback((tab: PerfDashboardTab) => updateView({ tab }), [updateView])
  const openDiagnose = useCallback(() => openTab("diagnose"), [openTab])

  const handleExport = useCallback(
    (format: PerfExportFormat) => {
      const result = exportPerfSnapshot({ latest, history, format })
      if (result) toast.success(t("toolbar.export.done", { filename: result.filename }))
    },
    [latest, history, t]
  )

  const hostSource = sources.find((source) => source.kind === "host") ?? null
  const hostAvailable = hostState === "live" || hostHistory.length > 0
  const latestHost = hostHistory.at(-1) ?? null
  const hostReports = (capability: string) => Boolean(hostSource?.capabilities.includes(capability))
  // Span hotspots and system facts come from the Rust sampler inside this
  // desktop app; the Node host reports neither.
  const rustHost = hostSource?.runtimeKind === "tauri-rust"

  const hostSection = (
    section: PerfResourceSection | "hotspots",
    reported: boolean,
    content: React.ReactNode
  ) =>
    !hostAvailable ? (
      <PerfHostUnavailable
        hostState={hostState}
        issue={hostIssue}
        section={section}
        onOpenDiagnose={section === "hotspots" ? undefined : openDiagnose}
      />
    ) : !reported ? (
      <PerfHostUnavailable hostState={hostState} section={section} notReported />
    ) : (
      content
    )

  const hotspotsSection = hostSection(
    "hotspots",
    rustHost,
    <PerfHotspotsTable
      spans={latestHost?.topSpans ?? []}
      onReset={rustHost ? perfResetHotspots : undefined}
    />
  )
  const timingsSection = (
    <PerfRendererTimingsTable
      readMeasurements={readRendererMeasurements}
      onClear={clearRendererMeasurements}
      version={rendererHistory.at(-1)?.sequence ?? 0}
    />
  )

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="performance-dashboard"
    >
      <FeaturePageHeader
        icon={<ActivityIcon />}
        title={t("title")}
        status={
          <PerfLiveStatus
            paused={paused}
            intervalMs={intervalMs}
            recording={capture.active}
            onOpenCaptures={() => openTab("captures")}
          />
        }
        actions={
          <PerfToolbar
            paused={paused}
            intervalMs={intervalMs}
            onTogglePause={() => setPaused(!paused)}
            onIntervalChange={setIntervalMs}
            onReset={reset}
            onExport={handleExport}
          />
        }
      />

      <Tabs
        value={view.tab}
        onValueChange={(value) => openTab(value as PerfDashboardTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-4 mt-3 flex w-auto max-w-[calc(100%-2rem)] justify-start overflow-x-auto">
          <TabsTrigger value="overview" data-testid="perf-tab-overview">
            <CpuIcon className="mr-1 size-4" />
            {t("tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="diagnose" data-testid="perf-tab-diagnose">
            <StethoscopeIcon className="mr-1 size-4" />
            {t("tabs.diagnose")}
          </TabsTrigger>
          <TabsTrigger value="resources" data-testid="perf-tab-resources">
            <BoxesIcon className="mr-1 size-4" />
            {t("tabs.resources")}
          </TabsTrigger>
          <TabsTrigger value="captures" data-testid="perf-tab-captures">
            <CameraIcon className="mr-1 size-4" />
            {t("tabs.captures")}
            {capture.active ? (
              <span
                aria-hidden
                className="ml-1 size-1.5 animate-pulse rounded-full bg-destructive"
                data-testid="perf-tab-captures-recording"
              />
            ) : null}
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <TabsContent value="overview" className="mt-0 space-y-4">
              <PerfSourceNotice
                hostState={hostState}
                issue={hostIssue}
                gaps={gaps}
                onOpenDetails={openDiagnose}
              />
              <PerfOverviewTab
                rendererHistory={rendererHistory}
                hostHistory={hostHistory}
                sources={sources}
                hostState={hostState}
                selectedMetric={view.metric}
                onSelectMetric={(metric: PerfMetricId) => updateView({ metric })}
                intervalMs={intervalMs}
                onOpenDiagnose={openDiagnose}
              />
              <PerfWebVitalsPanel />
              <PerfBrowserDiagnostics />
              {/* Plugin-contributed performance panels (custom metrics, etc.). */}
              <PluginExtensionSlot point="perf.panel" className="space-y-4 empty:hidden" />
            </TabsContent>

            <TabsContent value="diagnose" className="mt-0 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="max-w-prose text-sm text-muted-foreground">
                  {t("diagnose.description")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={PERF_TRACE_DASHBOARD_HREF} data-testid="perf-diagnose-traces">
                      <WaypointsIcon aria-hidden />
                      {t("diagnose.observability")}
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="sm">
                    <Link href="/logs" data-testid="perf-diagnose-logs">
                      <ScrollTextIcon aria-hidden />
                      {t("diagnose.logs")}
                    </Link>
                  </Button>
                </div>
              </div>
              <PerfOperationTimings />
              {/* What this runtime can measure comes first: with no host, the
                  hotspot placeholder used to fill the first screen and push the
                  Renderer timings below the fold. */}
              {hostAvailable ? (
                <>
                  {hotspotsSection}
                  {timingsSection}
                </>
              ) : (
                <>
                  {timingsSection}
                  {hotspotsSection}
                </>
              )}
              <PerfSourceHealth
                sources={sources}
                hostState={hostState}
                gaps={gaps}
                error={error}
                issue={hostIssue}
                collectionDurationMs={latest?.collectionDurationMs}
                actualIntervalMs={latest?.actualIntervalMs}
              />
            </TabsContent>

            <TabsContent value="resources" className="mt-0">
              <Tabs
                value={view.resource}
                onValueChange={(value) => updateView({ resource: value as PerfResourceSection })}
              >
                <TabsList className="mb-4 flex w-auto justify-start overflow-x-auto">
                  <TabsTrigger value="processes" data-testid="perf-resource-processes">
                    {t("tabs.processes")}
                  </TabsTrigger>
                  <TabsTrigger value="runtime" data-testid="perf-resource-runtime">
                    {t("tabs.runtime")}
                  </TabsTrigger>
                  <TabsTrigger value="managed" data-testid="perf-resource-managed">
                    {t("tabs.managed")}
                  </TabsTrigger>
                  <TabsTrigger value="system" data-testid="perf-resource-system">
                    {t("tabs.system")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="processes">
                  {hostSection(
                    "processes",
                    hostReports("host.processes"),
                    <PerfProcessTable history={hostHistory} />
                  )}
                </TabsContent>
                <TabsContent value="runtime">
                  {hostSection(
                    "runtime",
                    hostReports("runtime.tokio"),
                    <PerfRuntimeTab runtime={latestHost?.runtime ?? null} history={hostHistory} />
                  )}
                </TabsContent>
                <TabsContent value="managed">
                  {hostSection(
                    "managed",
                    hostReports("host.managed-processes") || hostReports("host.managed-workers"),
                    <PerfManagedProcesses latest={latestHost} />
                  )}
                </TabsContent>
                <TabsContent value="system">
                  {hostSection("system", rustHost, <PerfSystemTab />)}
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="captures" className="mt-0">
              <PerfCapturesTab hostAvailable={hostAvailable} />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  )
}
