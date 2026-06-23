"use client"

/**
 * Eval workspace shell — toggles between the datasets pane, the runs &
 * comparison pane, and the trace-analysis panel. Plain segmented buttons (not
 * Radix Tabs) to stay jsdom-friendly, matching the MCP/Skills panels.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { EvalDashboard } from "./eval-dashboard"
import { RunsComparePanel } from "./runs-compare-panel"
import { TraceAnnotationPanel } from "./trace-annotation-panel"
import { CalibrationPanel } from "./calibration-panel"

type EvalView = "datasets" | "compare" | "annotate" | "calibrate"

export function EvalWorkspace() {
  const t = useTranslations("eval")
  const [view, setView] = useState<EvalView>("datasets")

  const TABS: { key: EvalView; label: string }[] = [
    { key: "datasets", label: t("tabs.datasets") },
    { key: "compare", label: t("tabs.compare") },
    { key: "annotate", label: t("tabs.annotate") },
    { key: "calibrate", label: t("tabs.calibrate") },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b bg-background/80 p-2 backdrop-blur">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            size="sm"
            variant={view === tab.key ? "secondary" : "ghost"}
            aria-pressed={view === tab.key}
            onClick={() => setView(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
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
