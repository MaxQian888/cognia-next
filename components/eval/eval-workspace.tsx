"use client"

/**
 * Eval workspace shell — toggles between the datasets pane, the runs &
 * comparison pane, the trace-analysis panel, and judge calibration. Plain
 * segmented buttons (not Radix Tabs) to stay jsdom-friendly, matching the
 * MCP/Skills panels. A settings gear deep-links to the eval defaults section.
 *
 * Hosts the persistent run bar. Run progress used to live inside the run
 * dialog, so switching to Compare or Calibrate hid a run that was still
 * spending tokens, and closing the dialog left it unobservable and
 * uncancellable while it kept writing results.
 */

import { useState, type ComponentType } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { DatabaseIcon, GitCompareIcon, MicroscopeIcon, ScaleIcon, SettingsIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useEvalRunStore } from "@/stores/eval/eval-run-store"
import { EvalDashboard } from "./eval-dashboard"
import { RunsComparePanel } from "./runs-compare-panel"
import { TraceAnnotationPanel } from "./trace-annotation-panel"
import { CalibrationPanel } from "./calibration-panel"

type EvalView = "datasets" | "compare" | "annotate" | "calibrate"

export function EvalWorkspace() {
  const t = useTranslations("eval")
  const router = useRouter()
  const [view, setView] = useState<EvalView>("datasets")
  const activeRun = useEvalRunStore((s) => s.active)
  const cancelRun = useEvalRunStore((s) => s.cancel)

  const TABS: { key: EvalView; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { key: "datasets", label: t("tabs.datasets"), icon: DatabaseIcon },
    { key: "compare", label: t("tabs.compare"), icon: GitCompareIcon },
    { key: "annotate", label: t("tabs.annotate"), icon: MicroscopeIcon },
    { key: "calibrate", label: t("tabs.calibrate"), icon: ScaleIcon },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b bg-background/80 p-2 backdrop-blur">
        {TABS.map((tab) => {
          const Icon = tab.icon
          return (
            <Button
              key={tab.key}
              size="sm"
              variant={view === tab.key ? "secondary" : "ghost"}
              aria-pressed={view === tab.key}
              onClick={() => setView(tab.key)}
            >
              <Icon className="size-4" />
              {tab.label}
            </Button>
          )
        })}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          aria-label={t("settings.title")}
          onClick={() => router.push("/settings?section=eval")}
        >
          <SettingsIcon className="size-4" />
        </Button>
      </div>
      {activeRun && (
        <div
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 flex items-center gap-2 border-b px-3 py-1.5 text-xs"
          data-testid="eval-run-bar"
          role="status"
        >
          <span className="truncate font-medium">
            {t("runBar.label", { label: activeRun.label })}
          </span>
          <Progress
            className="min-w-0 flex-1"
            value={
              activeRun.progress
                ? (activeRun.progress.done / Math.max(1, activeRun.progress.total)) * 100
                : 0
            }
            aria-label={t("runConfig.progressLabel")}
          />
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {activeRun.progress
              ? `${activeRun.progress.done}/${activeRun.progress.total}`
              : t("runConfig.starting")}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 shrink-0 px-2"
            disabled={activeRun.cancelling}
            onClick={cancelRun}
          >
            {t("runConfig.cancelRun")}
          </Button>
        </div>
      )}

      <div
        key={view}
        className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 min-h-0 flex-1"
      >
        {view === "datasets" ? (
          <EvalDashboard />
        ) : view === "compare" ? (
          <RunsComparePanel />
        ) : view === "annotate" ? (
          <TraceAnnotationPanel />
        ) : (
          <CalibrationPanel />
        )}
      </div>
    </div>
  )
}
