"use client"

/**
 * PerformanceDashboard — the Task-Manager-style master panel for the Rust
 * backend. Four tabs (Overview graphs · Processes · Hotspots · Async Runtime)
 * driven by the live `usePerfStream` sampler. Desktop-only: on web/mobile it
 * renders an inert explainer instead of an empty shell.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { ActivityIcon, CpuIcon, GaugeIcon, LayersIcon } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { usePerfStream } from "@/hooks/perf/use-perf-stream"
import { exportPerfSnapshot, type PerfExportFormat } from "@/lib/perf/backend/export"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { PerfToolbar } from "./perf-toolbar"
import { PerfOverviewTab } from "./perf-overview-tab"
import { PerfProcessTable } from "./perf-process-table"
import { PerfHotspotsTable } from "./perf-hotspots-table"
import { PerfRuntimeTab } from "./perf-runtime-tab"

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
      <div
        className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
        data-testid="perf-desktop-only"
      >
        <GaugeIcon className="size-10 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t("desktopOnly.title")}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{t("desktopOnly.description")}</p>
      </div>
    )
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-bg-target="chat"
      data-testid="performance-dashboard"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <ActivityIcon className="size-5 text-primary" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{t("title")}</h1>
        </div>
        <div className="ml-auto">
          <PerfToolbar
            paused={paused}
            intervalMs={intervalMs}
            onTogglePause={() => setPaused(!paused)}
            onIntervalChange={setIntervalMs}
            onReset={reset}
            onExport={handleExport}
          />
        </div>
      </header>

      <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-3 w-fit">
          <TabsTrigger value="overview" data-testid="perf-tab-overview">
            <CpuIcon className="mr-1 size-4" />
            {t("tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="processes" data-testid="perf-tab-processes">
            <LayersIcon className="mr-1 size-4" />
            {t("tabs.processes")}
          </TabsTrigger>
          <TabsTrigger value="hotspots" data-testid="perf-tab-hotspots">
            <ActivityIcon className="mr-1 size-4" />
            {t("tabs.hotspots")}
          </TabsTrigger>
          <TabsTrigger value="runtime" data-testid="perf-tab-runtime">
            <GaugeIcon className="mr-1 size-4" />
            {t("tabs.runtime")}
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
            <TabsContent value="hotspots" className="mt-0">
              <PerfHotspotsTable spans={latest?.topSpans ?? []} />
            </TabsContent>
            <TabsContent value="runtime" className="mt-0">
              <PerfRuntimeTab runtime={latest?.runtime ?? null} history={history} />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  )
}
