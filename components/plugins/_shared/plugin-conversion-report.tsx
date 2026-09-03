"use client"

/**
 * What a foreign plugin bundle lost on its way to a Cognia manifest.
 *
 * `convertPluginBundle` has always produced a `PluginConversionReport` with
 * per-capability `converted`, `warnings` and `blocking` entries. The only
 * surface that rendered it printed two numbers, so every message the converter
 * wrote was computed and thrown away. The `structured` fidelity string even
 * promised "anything host-specific is listed below" next to a card that listed
 * nothing.
 *
 * Blockers come first, then warnings. Converted capabilities stay in the count
 * line: a user deciding whether to install cares about what did not survive,
 * and twenty "this worked" lines bury the two that did not.
 */

import { useTranslations } from "next-intl"

import {
  FidelitySummary,
  type FidelityBadgeVariant,
  type FidelitySummaryEntry,
} from "@/components/common/fidelity-summary"
import type {
  PluginConversionFidelity,
  PluginConversionReport as PluginConversionReportData,
  PluginEcosystem,
} from "@/lib/plugin/convert/ecosystem"

/** How many issues to show before folding the rest into a count. */
const MAX_ISSUES = 8

const BADGE_VARIANT: Record<PluginConversionFidelity, FidelityBadgeVariant> = {
  "native-exact": "default",
  structured: "secondary",
  contextual: "secondary",
  unsupported: "destructive",
}

export interface PluginConversionReportProps {
  sourceFormat: PluginEcosystem
  report: PluginConversionReportData
  /** Cap the issue list. Pass `false` to show every issue. */
  maxIssues?: number | false
  className?: string
}

export function PluginConversionReport({
  sourceFormat,
  report,
  maxIssues = MAX_ISSUES,
}: PluginConversionReportProps) {
  const t = useTranslations("plugins.conversionReport")

  const entries: FidelitySummaryEntry[] = [
    ...report.blocking.map((issue, index) => ({
      id: `blocking-${issue.capability}-${issue.path}-${index}`,
      path: issue.path || undefined,
      label: t("issueBlocking", { capability: issue.capability }),
      detail: issue.message,
    })),
    ...report.warnings.map((issue, index) => ({
      id: `warning-${issue.capability}-${issue.path}-${index}`,
      path: issue.path || undefined,
      label: t("issueWarning", { capability: issue.capability }),
      detail: issue.message,
    })),
  ]

  return (
    <FidelitySummary
      testId="plugin-conversion-report"
      title={t("title")}
      badges={[
        {
          id: "fidelity",
          label: t(`fidelity.${report.fidelity}`),
          variant: BADGE_VARIANT[report.fidelity],
          testId: "plugin-conversion-fidelity",
        },
      ]}
      // Counts live in the hints, not in `countLabel`, so they survive the
      // no-issues case. A report reading only "Everything carried over." drops
      // the fact that anything was converted at all.
      hints={[
        t("source", { source: t(`sources.${sourceFormat}`) }),
        t(`fidelityHint.${report.fidelity}`),
        t("counts", {
          converted: report.converted.length,
          warnings: report.warnings.length,
          blocking: report.blocking.length,
        }),
      ]}
      entries={entries}
      emptyLabel={t("noIssues")}
      emptyTestId="plugin-conversion-no-issues"
      maxEntries={maxIssues === false ? undefined : maxIssues}
      moreLabel={(hidden) => t("more", { count: hidden })}
    />
  )
}
