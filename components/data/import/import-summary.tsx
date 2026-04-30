"use client"

// Receipt rendered after a successful import. Shows per-table tallies for
// added / overwritten / skipped / built-ins-preserved.

import { useTranslations } from "next-intl"
import type { ImportSummary as Summary } from "@/lib/data/types"

export function ImportSummary({ summary }: { summary: Summary }) {
  const t = useTranslations("settings.data")
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-xs">
      <p className="mb-1 font-medium">{t("summary")}</p>
      <SummaryGroup label={t("summaryAdded")} map={summary.added} />
      <SummaryGroup label={t("summaryOverwritten")} map={summary.overwritten} />
      <SummaryGroup label={t("summarySkipped")} map={summary.skipped} />
      <SummaryGroup label={t("summaryBuiltIns")} map={summary.builtInsSkipped} />
    </div>
  )
}

function SummaryGroup({ label, map }: { label: string; map: Record<string, number> }) {
  const entries = Object.entries(map)
  if (entries.length === 0) return null
  return (
    <p className="text-muted-foreground">
      <span className="font-medium">{label}:</span>{" "}
      {entries.map(([k, v]) => `${k}=${v}`).join(", ")}
    </p>
  )
}
