"use client"

/**
 * Runs & Compare pane: lists recent eval runs and drives the
 * {@link RunComparisonView} A-vs-B grid over them.
 */

import { useTranslations } from "next-intl"
import { GitCompareIcon } from "lucide-react"
import { useRecentRuns } from "@/hooks/eval/use-eval-data"
import { RunComparisonView } from "./run-comparison-view"

export function RunsComparePanel() {
  const t = useTranslations("eval")
  const runs = useRecentRuns(50)

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4"
      data-testid="runs-compare-panel"
    >
      <header className="flex items-center gap-2">
        <GitCompareIcon className="size-5" />
        <div>
          <h1 className="text-lg font-semibold">{t("compare.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("compare.subtitle")}</p>
        </div>
      </header>
      {runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("runs.empty")}</p>
      ) : (
        <RunComparisonView runs={runs} />
      )}
    </div>
  )
}
