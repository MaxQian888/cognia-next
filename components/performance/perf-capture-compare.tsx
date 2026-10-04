"use client"

/**
 * Compare two captures on one metric, with the eligibility verdict ADR-0035
 * requires next to the numbers.
 *
 * The comparison used to be a single button that read main-process CPU off
 * both captures and printed five numbers — whatever the captures were. A
 * Renderer capture has no processes, so comparing it "worked" and printed
 * N/A; two captures at different cadences or across an app restart printed a
 * confident percent delta. Now the metric is chosen from the catalog, the
 * baseline is explicit (the older capture, swappable), and every reason the
 * pair is not like-for-like is listed. Statistics are still shown when the
 * pair is ineligible — the ADR wants them reported, just not read as a verdict.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowLeftRightIcon,
  CheckCircle2Icon,
  GitCompareIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { CaptureComparisonResult, DecodedCapture } from "@/lib/perf/capture-analysis"
import { compareCaptures } from "@/lib/perf/capture-analysis"
import type { PerformanceCaptureRow } from "@/lib/perf/capture-types"
import {
  formatPerfMetricValue,
  metricsForSourceKind,
  type PerfMetricId,
} from "@/lib/perf/metric-catalog"
import { cn } from "@/lib/utils"

export interface PerfCaptureCompareProps {
  /** Exactly the two captures ticked in the library, any order. */
  captures: readonly [PerformanceCaptureRow, PerformanceCaptureRow]
  /** Decrypts a capture; rejects with an error code the parent localizes. */
  loadCapture: (captureId: string) => Promise<DecodedCapture>
  /** Localizes a thrown error for display. */
  describeError: (error: unknown) => string
  disabled?: boolean
}

export function PerfCaptureCompare({
  captures,
  loadCapture,
  describeError,
  disabled = false,
}: PerfCaptureCompareProps) {
  const t = useTranslations("performance.captures.comparison")
  const tMetrics = useTranslations("performance.metrics")
  // Older first: the natural reading is "what changed since the earlier run".
  const ordered = useMemo(
    () => [...captures].sort((left, right) => left.startedAt - right.startedAt),
    [captures]
  )
  const [swapped, setSwapped] = useState(false)
  const baseline = swapped ? ordered[1] : ordered[0]
  const candidate = swapped ? ordered[0] : ordered[1]
  const sameSource = baseline.sourceKind === candidate.sourceKind
  const metricOptions = metricsForSourceKind(baseline.sourceKind)
  const [metricId, setMetricId] = useState<PerfMetricId>(
    metricOptions[0]?.id ?? "host.main.cpu-pct"
  )
  // A swap can change the baseline's source kind; fall back to its first metric.
  const metric = metricOptions.find((option) => option.id === metricId) ?? metricOptions[0] ?? null
  const [acceptEnvironment, setAcceptEnvironment] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CaptureComparisonResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    if (!metric) return
    setRunning(true)
    setError(null)
    try {
      const [left, right] = await Promise.all([loadCapture(baseline.id), loadCapture(candidate.id)])
      setResult(
        compareCaptures(left, right, metric, { environmentMismatchAccepted: acceptEnvironment })
      )
    } catch (caught) {
      setResult(null)
      setError(describeError(caught))
    } finally {
      setRunning(false)
    }
  }

  const format = (value: number | null) =>
    metric ? formatPerfMetricValue(metric.unit, value) : t("na")
  const deltaTone =
    result && result.comparison.absoluteDelta !== null && result.comparison.absoluteDelta !== 0
      ? (result.metric.direction === "lower") === result.comparison.absoluteDelta > 0
        ? "worse"
        : "better"
      : "neutral"

  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="perf-capture-compare">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <GitCompareIcon className="size-4" aria-hidden />
          {t("title")}
        </h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setSwapped((value) => !value)
            setResult(null)
          }}
          data-testid="perf-compare-swap"
        >
          <ArrowLeftRightIcon aria-hidden />
          {t("swap")}
        </Button>
      </header>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded border p-2">
          <dt className="text-muted-foreground">{t("baseline")}</dt>
          <dd className="truncate font-mono" data-testid="perf-compare-baseline">
            {baseline.id}
          </dd>
        </div>
        <div className="rounded border p-2">
          <dt className="text-muted-foreground">{t("candidate")}</dt>
          <dd className="truncate font-mono" data-testid="perf-compare-candidate">
            {candidate.id}
          </dd>
        </div>
      </dl>
      {!sameSource ? (
        <p className="text-xs text-warning" role="status" data-testid="perf-compare-source-warning">
          {t("sourceMismatch")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="perf-compare-metric">{t("metric")}</Label>
          <Select
            value={metric?.id}
            onValueChange={(value) => {
              setMetricId(value as PerfMetricId)
              setResult(null)
            }}
          >
            <SelectTrigger id="perf-compare-metric" className="w-[240px]" aria-label={t("metric")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metricOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {tMetrics(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Label className="flex items-center gap-2 text-xs font-normal">
          <Checkbox
            checked={acceptEnvironment}
            onCheckedChange={(checked) => {
              setAcceptEnvironment(checked === true)
              setResult(null)
            }}
            data-testid="perf-compare-accept-environment"
          />
          {t("acceptEnvironment")}
        </Label>
        <Button
          type="button"
          variant="outline"
          onClick={() => void run()}
          disabled={disabled || running || !metric}
          data-testid="perf-compare-run"
        >
          {running ? t("running") : t("compare")}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="space-y-3" role="status" data-testid="perf-compare-result">
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border p-2 text-sm",
              result.eligibility.eligible
                ? "border-success/40 bg-success/5"
                : "border-warning/40 bg-warning/5"
            )}
            data-testid="perf-compare-eligibility"
            data-eligible={result.eligibility.eligible}
          >
            {result.eligibility.eligible ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            ) : (
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            )}
            <div className="min-w-0 space-y-1">
              <p className="font-medium">
                {result.eligibility.eligible ? t("eligible") : t("ineligible")}
              </p>
              {result.eligibility.reasons.length > 0 ? (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                  {result.eligibility.reasons.map((reason) => (
                    <li key={reason} data-testid={`perf-compare-reason-${reason}`}>
                      {t(`reasons.${reason}`, {
                        baseline: Math.round(result.eligibility.baselineCoverage * 100),
                        candidate: Math.round(result.eligibility.candidateCoverage * 100),
                      })}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("statistic")}</TableHead>
                <TableHead className="text-right">{t("baseline")}</TableHead>
                <TableHead className="text-right">{t("candidate")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>{t("validIntervals")}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {result.baseline.validIntervals} / {result.baseline.expectedIntervals}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {result.candidate.validIntervals} / {result.candidate.expectedIntervals}
                </TableCell>
              </TableRow>
              {(["median", "p95", "mad"] as const).map((statistic) => (
                <TableRow key={statistic}>
                  <TableCell>{t(statistic)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {format(result.comparison.baseline[statistic])}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {format(result.comparison.candidate[statistic])}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p
            className={cn(
              "text-sm",
              deltaTone === "worse" && "text-destructive",
              deltaTone === "better" && "text-success"
            )}
            data-testid="perf-compare-delta"
            data-tone={deltaTone}
          >
            {t("deltaLine", {
              absolute:
                result.comparison.absoluteDelta === null
                  ? t("na")
                  : `${result.comparison.absoluteDelta >= 0 ? "+" : "−"}${format(
                      Math.abs(result.comparison.absoluteDelta)
                    )}`,
              percent:
                result.comparison.percentDelta === null
                  ? t("na")
                  : `${result.comparison.percentDelta >= 0 ? "+" : ""}${result.comparison.percentDelta.toFixed(1)}%`,
            })}
          </p>
        </div>
      ) : null}
    </section>
  )
}
