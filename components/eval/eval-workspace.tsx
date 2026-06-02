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

type EvalView = "datasets" | "compare" | "annotate"

export function EvalWorkspace() {
  const t = useTranslations("eval")
  const [view, setView] = useState<EvalView>("datasets")

  const TABS: { key: EvalView; label: string }[] = [
    { key: "datasets", label: t("tabs.datasets") },
    { key: "compare", label: t("tabs.compare") },
    { key: "annotate", label: t("tabs.annotate") },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
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
        ) : (
          <TraceAnnotationPanel />
        )}
      </div>
    </div>
  )
}
