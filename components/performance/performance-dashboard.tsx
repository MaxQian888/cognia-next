"use client"

/**
 * PerformanceDashboard — the Task-Manager-style master panel for the Rust
 * backend. Six tabs (Overview graphs · Processes · Managed · Hotspots · Async
 * Runtime · System) driven by the live `usePerfStream` sampler, except System,
 * whose facts are static and fetched once. Desktop-only: on web/mobile it
 * renders an inert explainer instead of an empty shell.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ActivityIcon, BoxesIcon, CpuIcon, GaugeIcon, LayersIcon, MonitorIcon } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
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

export function PerformanceDashboard() {
  const t = useTranslations("performance")
  const { history, latest, available, paused, intervalMs, setPaused, setIntervalMs, reset } =
    usePerfStream()

  const handleExport = useCallback(
    (format: PerfExportFormat) => {
      const result = exportPerfSnapshot({ latest, history, format })
      if (result) toast.success(t("toolbar.export.done", { filename: result.filename }))
    },
    [latest, history, t]
  )

  if (!available) {
    return (
      <Empty
        className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
        data-testid="perf-desktop-only"
      >
        <EmptyMedia variant="icon">
          <GaugeIcon className="size-8 text-muted-foreground" />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>{t("desktopOnly.title")}</EmptyTitle>
          <EmptyDescription className="max-w-sm">{t("desktopOnly.description")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

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
          <TabsTrigger value="processes" data-testid="perf-tab-processes">
            <LayersIcon className="mr-1 size-4" />
            {t("tabs.processes")}
          </TabsTrigger>
          <TabsTrigger value="managed" data-testid="perf-tab-managed">
            <BoxesIcon className="mr-1 size-4" />
            {t("tabs.managed")}
          </TabsTrigger>
          <TabsTrigger value="hotspots" data-testid="perf-tab-hotspots">
            <ActivityIcon className="mr-1 size-4" />
            {t("tabs.hotspots")}
          </TabsTrigger>
          <TabsTrigger value="runtime" data-testid="perf-tab-runtime">
            <GaugeIcon className="mr-1 size-4" />
            {t("tabs.runtime")}
          </TabsTrigger>
          <TabsTrigger value="system" data-testid="perf-tab-system">
            <MonitorIcon className="mr-1 size-4" />
            {t("tabs.system")}
          </TabsTrigger>
        </TabsList>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            <TabsContent value="overview" className="mt-0">
              <PerfOverviewTab history={history} />
              {/* Plugin-contributed performance panels (custom metrics, etc.). */}
              <PluginExtensionSlot point="perf.panel" className="mt-4 space-y-4 empty:hidden" />
            </TabsContent>
            <TabsContent value="processes" className="mt-0">
              <PerfProcessTable history={history} />
            </TabsContent>
            <TabsContent value="managed" className="mt-0">
              <PerfManagedProcesses latest={latest} />
            </TabsContent>
            <TabsContent value="hotspots" className="mt-0">
              <PerfHotspotsTable spans={latest?.topSpans ?? []} />
            </TabsContent>
            <TabsContent value="runtime" className="mt-0">
              <PerfRuntimeTab runtime={latest?.runtime ?? null} history={history} />
            </TabsContent>
            <TabsContent value="system" className="mt-0">
              <PerfSystemTab />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  )
}
