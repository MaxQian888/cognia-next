"use client"

/**
 * Eval workspace shell — toggles between the datasets/runs dashboard and the
 * trace-analysis panel. Plain segmented buttons (not Radix Tabs) to stay
 * jsdom-friendly, matching the MCP/Skills panels.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { EvalDashboard } from "./eval-dashboard"
import { TraceAnnotationPanel } from "./trace-annotation-panel"

type EvalView = "datasets" | "annotate"

export function EvalWorkspace() {
  const t = useTranslations("eval")
  const [view, setView] = useState<EvalView>("datasets")

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b p-2">
        <Button
          size="sm"
          variant={view === "datasets" ? "secondary" : "ghost"}
          aria-pressed={view === "datasets"}
          onClick={() => setView("datasets")}
        >
          {t("tabs.datasets")}
        </Button>
        <Button
          size="sm"
          variant={view === "annotate" ? "secondary" : "ghost"}
          aria-pressed={view === "annotate"}
          onClick={() => setView("annotate")}
        >
          {t("tabs.annotate")}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {view === "datasets" ? <EvalDashboard /> : <TraceAnnotationPanel />}
      </div>
    </div>
  )
}
