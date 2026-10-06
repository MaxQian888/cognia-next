"use client"

import { useMemo } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { ChevronDownIcon, ShieldCheckIcon } from "lucide-react"
import { filterEvalReportCases, type EvalReportView } from "@cognia/eval-core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export interface EvalReportPanelProps {
  reportView: EvalReportView | null
  reportVariant: string
  reportStatus: string
  onVariantChange: (variant: string) => void
  onStatusChange: (status: string) => void
}

export function EvalReportPanel({
  reportView,
  reportVariant,
  reportStatus,
  onVariantChange,
  onStatusChange,
}: EvalReportPanelProps) {
  const t = useTranslations("eval")
  const format = useFormatter()
  const recommendation = reportView?.recommendation?.result
  const filteredReportCases = useMemo(
    () =>
      reportView
        ? filterEvalReportCases(reportView.cases, {
            ...(reportVariant ? { variantId: reportVariant } : {}),
            ...(reportStatus ? { status: reportStatus as "passed" | "failed" | "errored" } : {}),
          })
        : [],
    [reportView, reportVariant, reportStatus]
  )
  return reportView ? (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("lab.review.frontier")}</CardTitle>
            <CardDescription>{t("lab.review.frontierHint")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {reportView.experiment.manifest.variants.map((variant) => (
              <div
                key={variant.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <span className="font-medium">{variant.name}</span>
                <Badge
                  variant={
                    recommendation?.paretoVariantIds.includes(variant.id) ? "default" : "secondary"
                  }
                >
                  {recommendation?.paretoVariantIds.includes(variant.id)
                    ? t("lab.review.onFrontier")
                    : t("lab.review.dominated")}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("lab.review.costSummary")}</CardTitle>
            <CardDescription>{t("lab.review.costSummaryHint")}</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            <div>
              <p className="text-xs text-muted-foreground">{t("lab.review.actualCost")}</p>
              <p className="mt-1 font-semibold">
                {format.number(reportView.cost.actual, {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 4,
                  maximumFractionDigits: 4,
                })}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("lab.review.estimatedCost")}</p>
              <p className="mt-1 font-semibold">
                {format.number(reportView.cost.estimatedWorstCase, {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 4,
                  maximumFractionDigits: 4,
                })}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("lab.run.cap")}</p>
              <p className="mt-1 font-semibold">
                {format.number(reportView.cost.hardCap, {
                  style: "currency",
                  currency: "USD",
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("lab.review.confidence")}</CardTitle>
          <CardDescription>{t("lab.review.confidenceHint")}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="min-w-[640px] text-sm">
            <TableHeader>
              <TableRow className="text-muted-foreground hover:bg-transparent">
                <TableHead className="p-2">{t("lab.review.variant")}</TableHead>
                <TableHead className="p-2">{t("lab.scoring.metrics.quality")}</TableHead>
                <TableHead className="p-2">{t("lab.scoring.metrics.reliability")}</TableHead>
                <TableHead className="p-2">{t("lab.scoring.metrics.cost")}</TableHead>
                <TableHead className="p-2">{t("lab.scoring.metrics.latency")}</TableHead>
                <TableHead className="p-2">{t("lab.review.effectiveCases")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reportView.evidence.map((candidate) => {
                const variant = reportView.experiment.manifest.variants.find(
                  (item) => item.id === candidate.variantId
                )
                return (
                  <TableRow key={candidate.variantId}>
                    <TableCell className="p-2 font-medium">
                      {variant?.name ?? candidate.variantId}
                    </TableCell>
                    <TableCell className="p-2 tabular-nums">
                      {candidate.metrics.quality.toFixed(3)} [
                      {candidate.intervals.quality.low.toFixed(3)},{" "}
                      {candidate.intervals.quality.high.toFixed(3)}]
                    </TableCell>
                    <TableCell className="p-2 tabular-nums">
                      {candidate.metrics.reliability.toFixed(3)}
                    </TableCell>
                    <TableCell className="p-2 tabular-nums">
                      {candidate.metrics.cost.toFixed(3)}
                    </TableCell>
                    <TableCell className="p-2 tabular-nums">
                      {candidate.metrics.latency.toFixed(3)}
                    </TableCell>
                    <TableCell className="p-2 tabular-nums">{candidate.effectiveCases}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {reportView.providerErrors.length ? (
        <Alert variant="destructive">
          <ShieldCheckIcon />
          <AlertTitle>{t("lab.review.providerErrors")}</AlertTitle>
          <AlertDescription>
            {t("lab.review.providerErrorsHint", { count: reportView.providerErrors.length })}
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("lab.review.caseEvidence")}</CardTitle>
          <CardDescription>{t("lab.review.caseEvidenceHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="eval-report-variant-filter">{t("lab.review.filterVariant")}</Label>
              <NativeSelect
                id="eval-report-variant-filter"
                wrapperClassName="w-full"
                value={reportVariant}
                onChange={(event) => onVariantChange(event.target.value)}
              >
                <NativeSelectOption value="">{t("lab.review.allVariants")}</NativeSelectOption>
                {reportView.experiment.manifest.variants.map((variant) => (
                  <NativeSelectOption key={variant.id} value={variant.id}>
                    {variant.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="eval-report-status-filter">{t("lab.review.filterStatus")}</Label>
              <NativeSelect
                id="eval-report-status-filter"
                wrapperClassName="w-full"
                value={reportStatus}
                onChange={(event) => onStatusChange(event.target.value)}
              >
                <NativeSelectOption value="">{t("lab.review.allStatuses")}</NativeSelectOption>
                <NativeSelectOption value="passed">
                  {t("lab.review.statuses.passed")}
                </NativeSelectOption>
                <NativeSelectOption value="failed">
                  {t("lab.review.statuses.failed")}
                </NativeSelectOption>
                <NativeSelectOption value="errored">
                  {t("lab.review.statuses.errored")}
                </NativeSelectOption>
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-3">
            {filteredReportCases.map((item) => (
              <Collapsible key={item.sampleId} className="group/collapsible rounded-lg border p-3">
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-between p-0 text-left font-medium"
                  >
                    <span>
                      {item.case.id} ·{" "}
                      {reportView.experiment.manifest.variants.find(
                        (variant) => variant.id === item.variantId
                      )?.name ?? item.variantId}{" "}
                      · {t(`lab.review.statuses.${item.status}`)}
                    </span>
                    <ChevronDownIcon className="size-4 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-180" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 grid gap-3 text-sm">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("lab.review.input")}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{item.case.input}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("lab.review.output")}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap">{item.sample.output}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {item.scores.map((score) => (
                      <Badge key={score.id} variant={score.passed ? "default" : "destructive"}>
                        {score.scorerId}: {score.value.toFixed(2)}
                      </Badge>
                    ))}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        </CardContent>
      </Card>
    </>
  ) : (
    <div className="grid h-40 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {t("lab.review.awaitingEvidence")}
    </div>
  )
}
