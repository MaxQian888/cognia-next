"use client"

/**
 * The routing experiment's report, as a person reads it (ADR-0188 B6).
 *
 * Presentational only — it takes a report and renders it, so the panel owns
 * every effect and this file can be tested with a literal.
 *
 * Two things it is responsible for getting right:
 *
 *  - **The label is never subtle.** A simulated report leads with its badge and
 *    its disclaimer, and where a live report would state a saving it states
 *    that it makes no claim (EVAL-04). The numbers are still shown — a
 *    rehearsal is worth looking at — but nothing on the page reads as evidence.
 *  - **Cost per accepted run is the headline.** Every run's spend over the
 *    accepted ones alone (EVAL-03), with "nothing was accepted" written out
 *    rather than shown as a zero, because an undefined ratio and a free run
 *    look identical once they are both rendered as a number.
 */

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { RoutingExperimentReport } from "@/lib/ai/eval/routing-experiment"

/**
 * Integer microusd as dollars. Written out here rather than imported from
 * `@cognia/router-fusion`'s money module: a component outside
 * `lib/router-fusion` may not import the engine statically (the opt-in
 * boundary gate), and a report that is already in memory should not need a
 * dynamic import to be displayed.
 */
export function formatMicrousd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  return `$${(value / 1_000_000).toFixed(4)}`
}

export function formatShare(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  return `${(value * 100).toFixed(1)}%`
}

interface RoutingReportSummaryProps {
  report: RoutingExperimentReport
}

export function RoutingReportSummary({ report }: RoutingReportSummaryProps) {
  const t = useTranslations("routerFusionEval")
  const acceptedCost = formatMicrousd(report.acceptedCost.costPerAcceptedMicrousd)
  const verdict = report.gate.gate?.verdict ?? null
  const saving = formatMicrousd(report.claims.costSavingMicrousd)

  return (
    <div className="space-y-4" data-testid="routing-report-summary">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={report.label === "simulated" ? "secondary" : "default"}>
          {t(`report.label.${report.label}`)}
        </Badge>
        <Badge variant="outline" data-testid="routing-report-verdict">
          {t("report.gate")}: {verdict ? t(`report.verdict.${verdict}`) : t("report.verdict.none")}
        </Badge>
      </div>

      <p className="text-muted-foreground text-xs">{report.disclaimer}</p>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground text-xs">{t("report.sampleCount")}</dt>
          <dd className="tabular-nums">{report.sampleCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t("report.acceptedCost")}</dt>
          <dd className="tabular-nums" data-testid="routing-report-accepted-cost">
            {acceptedCost ?? t("report.undefinedCost")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t("report.passRate")}</dt>
          <dd className="tabular-nums">{formatShare(report.acceptedCost.passRate) ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">{t("report.totalCost")}</dt>
          <dd className="tabular-nums">
            {formatMicrousd(report.acceptedCost.totalCostMicrousd) ?? "—"}
          </dd>
        </div>
      </dl>

      <p className="text-xs" data-testid="routing-report-claim">
        {saving === null ? t("report.noClaim") : t("report.claimSaving", { amount: saving })}
      </p>

      {report.gate.refusals.length > 0 && (
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-xs">
          {report.gate.refusals.map((refusal) => (
            <li key={refusal}>{t(`report.gateRefusal.${refusal}`)}</li>
          ))}
        </ul>
      )}

      <section>
        <h4 className="text-xs font-medium">{t("report.byAction")}</h4>
        <ul className="mt-1 space-y-1 text-xs">
          {report.byAction.map((row) => (
            <li key={row.actionHash} className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono">{row.actionId}</span>
              <span className="text-muted-foreground shrink-0 tabular-nums">
                {formatMicrousd(row.costPerAcceptedMicrousd) ?? t("report.undefinedCost")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-xs font-medium">{t("report.heads")}</h4>
        <ul className="mt-1 space-y-1 text-xs">
          {report.heads.map((head) => (
            <li key={head.actionHash} className="flex items-baseline justify-between gap-2">
              <span className="truncate font-mono">{head.actionId}</span>
              <span className="text-muted-foreground shrink-0">
                {head.publishable ? t("report.headCalibrated") : t("report.headWithheld")} ·{" "}
                {t("report.headSamples", {
                  training: head.trainingSamples,
                  calibration: head.calibrationSamples,
                  test: head.testSamples,
                })}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {report.caveats.length > 0 && (
        <section>
          <h4 className="text-xs font-medium">{t("report.caveats")}</h4>
          <ul className="text-muted-foreground mt-1 list-disc space-y-1 pl-5 text-xs">
            {report.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
