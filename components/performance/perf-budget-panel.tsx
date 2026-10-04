"use client"

/**
 * Performance budgets — named, immutable thresholds for one catalog metric,
 * and a check of a stored capture against one of them.
 *
 * `PerformanceBudgetService` (encrypted, immutable profiles in the account
 * registry) and `evaluateBudget` (the ADR-0035 verdict rules) were both built
 * and tested with no caller anywhere: the ADR's "budget verdicts" existed only
 * on paper. This panel is that caller. A verdict is only ever pass / warn /
 * fail when the capture has enough valid, continuous intervals at the
 * budget's cadence, on a runtime and build the budget applies to; otherwise
 * it says "insufficient data" or "not comparable" and why.
 *
 * Profiles are immutable by design (the service refuses to overwrite one), so
 * there is no edit: a changed threshold is a new budget.
 */

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { GaugeIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PerfRuntimeKind, PerfSourceKind } from "@/lib/perf/backend/types"
import type {
  CreatePerformanceBudgetProfileInput,
  PerformanceBudgetProfile,
} from "@/lib/perf/budget-service"
import {
  evaluateCaptureAgainstBudget,
  type CaptureBudgetEvaluation,
  type DecodedCapture,
} from "@/lib/perf/capture-analysis"
import type { PerformanceCaptureRow } from "@/lib/perf/capture-types"
import {
  formatPerfMetricValue,
  getPerfMetric,
  metricsForSourceKind,
  PERF_METRIC_SCHEMA_VERSION,
  thresholdInputScale,
  type PerfMetricId,
} from "@/lib/perf/metric-catalog"
import { PERF_INTERVAL_OPTIONS } from "@/hooks/perf/use-perf-stream"
import { cn } from "@/lib/utils"

type BuildProfile = "production" | "profiling" | "development"
const BUILD_PROFILES: BuildProfile[] = ["production", "profiling", "development"]
const RUNTIME_KINDS: Record<PerfSourceKind, PerfRuntimeKind[]> = {
  renderer: ["browser"],
  host: ["tauri-rust", "node-headless"],
}

/** What the panel needs from `PerformanceBudgetService`, injectable for tests. */
export interface PerfBudgetStore {
  list: () => Promise<PerformanceBudgetProfile[]>
  create: (input: CreatePerformanceBudgetProfileInput) => Promise<PerformanceBudgetProfile>
}

export interface PerfBudgetPanelProps {
  /** `null` while the account is locked: budgets are encrypted per account. */
  store: PerfBudgetStore | null
  /** Ready captures the user can check. */
  captures: readonly PerformanceCaptureRow[]
  loadCapture: (captureId: string) => Promise<DecodedCapture>
  describeError: (error: unknown) => string
}

const VERDICT_TONE: Record<CaptureBudgetEvaluation["verdict"], string> = {
  pass: "border-success/40 bg-success/5 text-success",
  warn: "border-warning/40 bg-warning/5 text-warning",
  fail: "border-destructive/40 bg-destructive/5 text-destructive",
  "insufficient-data": "border-border bg-muted/40 text-muted-foreground",
  incomparable: "border-border bg-muted/40 text-muted-foreground",
}

export function PerfBudgetPanel({
  store,
  captures,
  loadCapture,
  describeError,
}: PerfBudgetPanelProps) {
  const t = useTranslations("performance.budgets")
  const tMetrics = useTranslations("performance.metrics")
  const formatter = useFormatter()
  const [budgets, setBudgets] = useState<PerformanceBudgetProfile[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [budgetId, setBudgetId] = useState<string | null>(null)
  const [captureId, setCaptureId] = useState<string | null>(null)
  const [acceptEnvironment, setAcceptEnvironment] = useState(false)
  const [checking, setChecking] = useState(false)
  const [evaluation, setEvaluation] = useState<CaptureBudgetEvaluation | null>(null)

  // Bumped after a create so the list effect reloads.
  const [listVersion, setListVersion] = useState(0)

  // The encrypted profile store is an external system: load on mount, when the
  // account (store) changes, and after a create. State is set only in the
  // promise callbacks, guarded against a stale response.
  useEffect(() => {
    if (!store) return
    let cancelled = false
    store.list().then(
      (list) => {
        if (cancelled) return
        setBudgets(list)
        setLoadError(null)
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(describeError(error))
      }
    )
    return () => {
      cancelled = true
    }
  }, [describeError, listVersion, store])

  const selectedBudget = budgets.find((budget) => budget.id === budgetId) ?? budgets[0] ?? null
  // Only captures from the budget's source kind can ever be comparable.
  const eligibleCaptures = useMemo(
    () =>
      selectedBudget
        ? captures.filter((capture) => capture.sourceKind === selectedBudget.sourceKind)
        : [],
    [captures, selectedBudget]
  )
  const selectedCapture =
    eligibleCaptures.find((capture) => capture.id === captureId) ?? eligibleCaptures[0] ?? null

  const check = async () => {
    if (!selectedBudget || !selectedCapture) return
    setChecking(true)
    try {
      const decoded = await loadCapture(selectedCapture.id)
      setEvaluation(
        evaluateCaptureAgainstBudget(decoded, selectedBudget, {
          environmentMismatchAccepted: acceptEnvironment,
        })
      )
    } catch (error) {
      setEvaluation(null)
      toast.error(describeError(error))
    } finally {
      setChecking(false)
    }
  }

  const budgetMetric = selectedBudget ? getPerfMetric(selectedBudget.metricId) : null
  const formatBudgetValue = (value: number | null) =>
    budgetMetric ? formatPerfMetricValue(budgetMetric.unit, value) : String(value ?? "—")

  return (
    <section className="space-y-3" data-testid="perf-budget-panel">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-medium">
            <GaugeIcon className="size-4" aria-hidden />
            {t("title")}
          </h3>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCreating(true)}
          disabled={!store}
          data-testid="perf-budget-new"
        >
          <PlusIcon aria-hidden />
          {t("new")}
        </Button>
      </header>

      {!store ? (
        <p className="text-sm text-muted-foreground" data-testid="perf-budget-locked">
          {t("locked")}
        </p>
      ) : loadError ? (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      ) : budgets.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="perf-budget-empty">
          {t("empty")}
        </p>
      ) : (
        <>
          <ul className="divide-y rounded-md border" data-testid="perf-budget-list">
            {budgets.map((budget) => {
              const metric = getPerfMetric(budget.metricId)
              const fmt = (value: number) =>
                metric ? formatPerfMetricValue(metric.unit, value) : String(value)
              return (
                <li
                  key={budget.id}
                  className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                  data-testid={`perf-budget-${budget.id}`}
                >
                  <span className="font-medium">{budget.name}</span>
                  <Badge variant="secondary">
                    {metric ? tMetrics(metric.labelKey) : budget.metricId}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("summary", {
                      aggregation: t(`aggregation.${budget.aggregation}`),
                      direction: t(`direction.${budget.direction}`),
                      warning: fmt(budget.warningThreshold),
                      failure: fmt(budget.failureThreshold),
                      cadence: budget.requestedCadenceMs / 1000,
                    })}
                  </span>
                  <span className="ml-auto flex flex-wrap gap-1">
                    {budget.applicability.runtimeKinds.map((kind) => (
                      <Badge key={kind} variant="outline" className="text-[10px]">
                        {t(`runtimeKind.${kind}`)}
                      </Badge>
                    ))}
                    {budget.applicability.buildProfiles.map((profile) => (
                      <Badge key={profile} variant="outline" className="text-[10px]">
                        {t(`buildProfile.${profile}`)}
                      </Badge>
                    ))}
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="space-y-3 rounded-md border p-3" data-testid="perf-budget-check">
            <h4 className="text-sm font-medium">{t("check.title")}</h4>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="perf-budget-check-budget">{t("check.budget")}</Label>
                <Select
                  value={selectedBudget?.id}
                  onValueChange={(value) => {
                    setBudgetId(value)
                    setEvaluation(null)
                  }}
                >
                  <SelectTrigger id="perf-budget-check-budget" className="w-[220px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {budgets.map((budget) => (
                      <SelectItem key={budget.id} value={budget.id}>
                        {budget.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="perf-budget-check-capture">{t("check.capture")}</Label>
                <Select
                  value={selectedCapture?.id}
                  onValueChange={(value) => {
                    setCaptureId(value)
                    setEvaluation(null)
                  }}
                  disabled={eligibleCaptures.length === 0}
                >
                  <SelectTrigger id="perf-budget-check-capture" className="w-[260px]">
                    <SelectValue placeholder={t("check.noCaptures")} />
                  </SelectTrigger>
                  <SelectContent>
                    {eligibleCaptures.map((capture) => (
                      <SelectItem key={capture.id} value={capture.id}>
                        {formatter.dateTime(capture.startedAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
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
                    setEvaluation(null)
                  }}
                />
                {t("check.acceptEnvironment")}
              </Label>
              <Button
                type="button"
                variant="outline"
                onClick={() => void check()}
                disabled={checking || !selectedBudget || !selectedCapture}
                data-testid="perf-budget-check-run"
              >
                {checking ? t("check.running") : t("check.run")}
              </Button>
            </div>
            {evaluation ? (
              <div
                role="status"
                className={cn("rounded-md border p-2 text-sm", VERDICT_TONE[evaluation.verdict])}
                data-testid="perf-budget-verdict"
                data-verdict={evaluation.verdict}
              >
                <p className="font-medium">{t(`verdict.${evaluation.verdict}`)}</p>
                <p className="mt-1 text-xs text-foreground/80">
                  {t("check.detail", {
                    value: formatBudgetValue(evaluation.value),
                    valid: evaluation.validIntervals,
                    expected: evaluation.expectedIntervals,
                  })}
                </p>
                {evaluation.reason ? (
                  <p className="mt-1 text-xs text-foreground/80">
                    {t(`reason.${evaluation.reason}`)}
                  </p>
                ) : null}
                {!evaluation.environmentMatches && acceptEnvironment ? (
                  <p className="mt-1 text-xs text-foreground/80">
                    {t("check.environmentAccepted")}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      )}

      {store ? (
        <PerfBudgetDialog
          open={creating}
          onOpenChange={setCreating}
          onCreate={async (input) => {
            await store.create(input)
            toast.success(t("created", { name: input.name }))
            setListVersion((version) => version + 1)
          }}
          describeError={describeError}
        />
      ) : null}
    </section>
  )
}

interface BudgetDraft {
  name: string
  sourceKind: PerfSourceKind
  metricId: PerfMetricId
  aggregation: "median" | "p95"
  warning: string
  failure: string
  cadenceMs: number
  runtimeKinds: PerfRuntimeKind[]
  buildProfiles: BuildProfile[]
}

function initialDraft(): BudgetDraft {
  const metric = metricsForSourceKind("renderer")[0]
  return {
    name: "",
    sourceKind: "renderer",
    metricId: metric.id,
    aggregation: "p95",
    warning: "",
    failure: "",
    cadenceMs: 1000,
    runtimeKinds: RUNTIME_KINDS.renderer,
    buildProfiles: ["production"],
  }
}

/**
 * Validate a draft into a service input, or return the i18n key of the first
 * problem. Thresholds are typed in the metric's input unit (MB for bytes).
 */
export function budgetDraftToInput(
  draft: BudgetDraft
): { input: CreatePerformanceBudgetProfileInput } | { error: string } {
  const metric = getPerfMetric(draft.metricId)
  if (!metric || metric.sourceKind !== draft.sourceKind) return { error: "metric" }
  if (!draft.name.trim()) return { error: "name" }
  const scale = thresholdInputScale(metric.unit)
  const warning = Number(draft.warning) * scale
  const failure = Number(draft.failure) * scale
  if (draft.warning.trim() === "" || draft.failure.trim() === "") return { error: "thresholds" }
  if (!Number.isFinite(warning) || !Number.isFinite(failure)) return { error: "thresholds" }
  const ordered = metric.direction === "lower" ? warning <= failure : warning >= failure
  if (!ordered) return { error: `order.${metric.direction}` }
  if (draft.runtimeKinds.length === 0) return { error: "runtimeKinds" }
  if (draft.buildProfiles.length === 0) return { error: "buildProfiles" }
  return {
    input: {
      name: draft.name.trim(),
      version: 1,
      metricId: metric.id,
      metricDefinitionVersion: metric.definitionVersion,
      unit: metric.unit,
      sourceKind: metric.sourceKind,
      metricSchemaVersion: PERF_METRIC_SCHEMA_VERSION,
      requestedCadenceMs: draft.cadenceMs,
      aggregation: draft.aggregation,
      direction: metric.direction,
      warningThreshold: warning,
      failureThreshold: failure,
      applicability: { runtimeKinds: draft.runtimeKinds, buildProfiles: draft.buildProfiles },
      comparisonWindow: "interval",
    },
  }
}

function PerfBudgetDialog({
  open,
  onOpenChange,
  onCreate,
  describeError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: CreatePerformanceBudgetProfileInput) => Promise<void>
  describeError: (error: unknown) => string
}) {
  const t = useTranslations("performance.budgets.form")
  const tMetrics = useTranslations("performance.metrics")
  const tBudgets = useTranslations("performance.budgets")
  const [draft, setDraft] = useState<BudgetDraft>(initialDraft)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const metric = getPerfMetric(draft.metricId)
  const unitSuffix = metric ? t(`unit.${metric.unit}`) : ""

  const update = (patch: Partial<BudgetDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    setError(null)
  }

  const submit = async () => {
    const result = budgetDraftToInput(draft)
    if ("error" in result) {
      setError(t(`errors.${result.error}`))
      return
    }
    setSaving(true)
    try {
      await onCreate(result.input)
      setDraft(initialDraft())
      onOpenChange(false)
    } catch (caught) {
      setError(describeError(caught))
    } finally {
      setSaving(false)
    }
  }

  const toggle = <T extends string>(list: T[], value: T, checked: boolean): T[] =>
    checked ? [...new Set([...list, value])] : list.filter((item) => item !== value)

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg" data-testid="perf-budget-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="perf-budget-name">{t("name")}</Label>
            <Input
              id="perf-budget-name"
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder={t("namePlaceholder")}
              data-testid="perf-budget-name"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="perf-budget-source">{t("source")}</Label>
              <Select
                value={draft.sourceKind}
                onValueChange={(value) => {
                  const sourceKind = value as PerfSourceKind
                  update({
                    sourceKind,
                    metricId: metricsForSourceKind(sourceKind)[0].id,
                    runtimeKinds: RUNTIME_KINDS[sourceKind],
                  })
                }}
              >
                <SelectTrigger id="perf-budget-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="renderer">{tBudgets("sourceKind.renderer")}</SelectItem>
                  <SelectItem value="host">{tBudgets("sourceKind.host")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-budget-metric">{t("metric")}</Label>
              <Select
                value={draft.metricId}
                onValueChange={(value) => update({ metricId: value as PerfMetricId })}
              >
                <SelectTrigger id="perf-budget-metric">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metricsForSourceKind(draft.sourceKind).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {tMetrics(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-budget-aggregation">{t("aggregation")}</Label>
              <Select
                value={draft.aggregation}
                onValueChange={(value) => update({ aggregation: value as "median" | "p95" })}
              >
                <SelectTrigger id="perf-budget-aggregation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="median">{tBudgets("aggregation.median")}</SelectItem>
                  <SelectItem value="p95">{tBudgets("aggregation.p95")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-budget-cadence">{t("cadence")}</Label>
              <Select
                value={String(draft.cadenceMs)}
                onValueChange={(value) => update({ cadenceMs: Number(value) })}
              >
                <SelectTrigger id="perf-budget-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERF_INTERVAL_OPTIONS.map((ms) => (
                    <SelectItem key={ms} value={String(ms)}>
                      {t("cadenceValue", { seconds: ms / 1000 })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-budget-warning">{t("warning", { unit: unitSuffix })}</Label>
              <Input
                id="perf-budget-warning"
                type="number"
                inputMode="decimal"
                value={draft.warning}
                onChange={(event) => update({ warning: event.target.value })}
                data-testid="perf-budget-warning"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="perf-budget-failure">{t("failure", { unit: unitSuffix })}</Label>
              <Input
                id="perf-budget-failure"
                type="number"
                inputMode="decimal"
                value={draft.failure}
                onChange={(event) => update({ failure: event.target.value })}
                data-testid="perf-budget-failure"
              />
            </div>
          </div>
          {metric ? (
            <p className="text-xs text-muted-foreground">
              {t(`directionHint.${metric.direction}`)}
            </p>
          ) : null}
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("runtimeKinds")}</legend>
            <div className="flex flex-wrap gap-3">
              {RUNTIME_KINDS[draft.sourceKind].map((kind) => (
                <Label key={kind} className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    checked={draft.runtimeKinds.includes(kind)}
                    onCheckedChange={(checked) =>
                      update({ runtimeKinds: toggle(draft.runtimeKinds, kind, checked === true) })
                    }
                  />
                  {tBudgets(`runtimeKind.${kind}`)}
                </Label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t("buildProfiles")}</legend>
            <div className="flex flex-wrap gap-3">
              {BUILD_PROFILES.map((profile) => (
                <Label key={profile} className="flex items-center gap-2 text-sm font-normal">
                  <Checkbox
                    checked={draft.buildProfiles.includes(profile)}
                    onCheckedChange={(checked) =>
                      update({
                        buildProfiles: toggle(draft.buildProfiles, profile, checked === true),
                      })
                    }
                  />
                  {tBudgets(`buildProfile.${profile}`)}
                </Label>
              ))}
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground">{t("immutable")}</p>
          {error ? (
            <p role="alert" className="text-sm text-destructive" data-testid="perf-budget-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={saving}
            data-testid="perf-budget-save"
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
