"use client"

/**
 * Capability-driven diagnostic workspace. Renderer data is always available
 * in authenticated full shells; selected-host resources progressively appear
 * when the active transport advertises them.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import Link from "next/link"
import { ActivityIcon, BoxesIcon, CameraIcon, CpuIcon, StethoscopeIcon } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { usePerfStream } from "@/hooks/perf/use-perf-stream"
import { exportPerfSnapshot, type PerfExportFormat } from "@/lib/perf/backend/export"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { PerfToolbar } from "./perf-toolbar"
import { PerfOverviewTab } from "./perf-overview-tab"
import { PerfProcessTable } from "./perf-process-table"
import { PerfManagedProcesses } from "./perf-managed-processes"
import { PerfHotspotsTable } from "./perf-hotspots-table"
import { PerfRuntimeTab } from "./perf-runtime-tab"
import { PerfSystemTab } from "./perf-system-tab"
import { PerfSourceHealth } from "./perf-source-health"
import { PerfCapturesTab } from "./perf-captures-tab"

export function PerformanceDashboard() {
  const t = useTranslations("performance")
  const {
    history,
    latest,
    rendererHistory,
    hostHistory,
    sources,
    gaps,
    hostState,
    error,
    paused,
    intervalMs,
    setPaused,
    setIntervalMs,
    reset,
  } = usePerfStream()

  const handleExport = useCallback(
    (format: PerfExportFormat) => {
      const result = exportPerfSnapshot({ latest, history, format })
      if (result) toast.success(t("toolbar.export.done", { filename: result.filename }))
    },
    [latest, history, t]
  )

  const hostAvailable = hostState === "live" || hostHistory.length > 0

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="performance-dashboard"
    >
      <FeaturePageHeader
        icon={<ActivityIcon />}
        title={t("title")}
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

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
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
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <TabsContent value="overview" className="mt-0">
              <div className="space-y-4">
                <PerfSourceHealth
                  sources={sources}
                  hostState={hostState}
                  gaps={gaps}
                  error={error}
                  collectionDurationMs={latest?.collectionDurationMs}
                  actualIntervalMs={latest?.actualIntervalMs}
                />
                <PerfOverviewTab history={history} />
              </div>
              {/* Plugin-contributed performance panels (custom metrics, etc.). */}
              <PluginExtensionSlot point="perf.panel" className="mt-4 space-y-4 empty:hidden" />
            </TabsContent>
            <TabsContent value="diagnose" className="mt-0 space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline">
                  <Link href="/observability">{t("diagnose.observability")}</Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/logs">{t("diagnose.logs")}</Link>
                </Button>
              </div>
              <PerfHotspotsTable spans={latest?.topSpans ?? []} />
            </TabsContent>
            <TabsContent value="resources" className="mt-0">
              <Tabs defaultValue="renderer">
                <TabsList className="mb-4 flex w-auto justify-start overflow-x-auto">
                  <TabsTrigger value="renderer">{t("resources.renderer")}</TabsTrigger>
                  <TabsTrigger value="host" disabled={!hostAvailable}>
                    {t("resources.host")}
                  </TabsTrigger>
                  <TabsTrigger value="runtime" disabled={!hostAvailable}>
                    {t("tabs.runtime")}
                  </TabsTrigger>
                  <TabsTrigger value="processes" disabled={!hostAvailable}>
                    {t("tabs.processes")}
                  </TabsTrigger>
                  <TabsTrigger value="managed" disabled={!hostAvailable}>
                    {t("tabs.managed")}
                  </TabsTrigger>
                  <TabsTrigger value="system" disabled={!hostAvailable}>
                    {t("tabs.system")}
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="renderer">
                  <PerfOverviewTab history={rendererHistory} />
                </TabsContent>
                <TabsContent value="host">
                  <PerfOverviewTab history={hostHistory} />
                </TabsContent>
                <TabsContent value="runtime">
                  <PerfRuntimeTab
                    runtime={hostHistory.at(-1)?.runtime ?? null}
                    history={hostHistory}
                  />
                </TabsContent>
                <TabsContent value="processes">
                  <PerfProcessTable history={hostHistory} />
                </TabsContent>
                <TabsContent value="managed">
                  <PerfManagedProcesses latest={hostHistory.at(-1) ?? null} />
                </TabsContent>
                <TabsContent value="system">
                  <PerfSystemTab />
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
