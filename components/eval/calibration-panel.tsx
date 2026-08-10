"use client"

/**
 * Judge calibration panel (eval spec §10) — the loop that makes LLM-judge
 * scores trustworthy. The user maintains a human-gold-labeled set of (request,
 * answer) pairs for one judge (criterion + rubric), runs the judge over them,
 * and reads the agreement: a confusion matrix, TPR/TNR/precision/F1/accuracy,
 * and Cohen's κ — plus the disagreement list (judge ≠ human, with the judge's
 * reasoning) that drives rubric refinement, and a κ-over-time history for
 * detecting judge regressions across model/rubric changes.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ScaleIcon, PlayIcon, Trash2Icon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  useCalibrationSets,
  useCalibrationItems,
  useCalibrationRuns,
  useLatestCalibrationRun,
} from "@/hooks/eval/use-eval-data"
import {
  upsertCalibrationItem,
  newCalibrationSetId,
  setGoldLabel,
  deleteCalibrationItem,
  type CalibrationItemRow,
  type CalibrationLabel,
} from "@/lib/db/calibration-items"
import { runCalibration, CalibrationNoJudgeError } from "@/lib/ai/eval/calibration/runner"
import type { AgreementMetrics } from "@/lib/ai/eval/calibration/metrics"
import type { CalibrationRunRow } from "@/lib/db/calibration-runs"

const DASH = "—"

/** Format a [0,1] rate as a percentage, or an em-dash when undefined. */
function pct(value: number | null): string {
  return value === null ? DASH : `${(value * 100).toFixed(1)}%`
}

/** Format Cohen's κ as a signed 3-decimal number, or an em-dash. */
function kappa(value: number | null): string {
  return value === null ? DASH : value.toFixed(3)
}

function GoldToggle({ item }: { item: CalibrationItemRow }) {
  const t = useTranslations("eval")
  const set = useCallback(
    (label: CalibrationLabel) => {
      void setGoldLabel(item.id, label)
    },
    [item.id]
  )
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={item.goldLabel === "pass" ? "secondary" : "ghost"}
        aria-pressed={item.goldLabel === "pass"}
        onClick={() => set("pass")}
      >
        {t("calibration.goldPass")}
      </Button>
      <Button
        size="sm"
        variant={item.goldLabel === "fail" ? "secondary" : "ghost"}
        aria-pressed={item.goldLabel === "fail"}
        onClick={() => set("fail")}
      >
        {t("calibration.goldFail")}
      </Button>
    </div>
  )
}

function ItemRow({ item }: { item: CalibrationItemRow }) {
  const t = useTranslations("eval")
  return (
    <Card className="flex flex-col gap-2 p-3" data-testid="calibration-item">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium">{item.input}</p>
          <p className="line-clamp-2 text-muted-foreground text-sm">{item.output}</p>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {t(`calibration.sources.${item.source}`)}
        </Badge>
      </div>
      <div className="flex items-center justify-between gap-2">
        <GoldToggle item={item} />
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("calibration.delete")}
          onClick={() => void deleteCalibrationItem(item.id)}
        >
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </Card>
  )
}

function NewSetForm({
  onCreate,
}: {
  onCreate: (set: { setId: string; setName: string; criterion: string; rubric: string }) => void
}) {
  const t = useTranslations("eval")
  const [name, setName] = useState("")
  const [criterion, setCriterion] = useState("")
  const [rubric, setRubric] = useState("")

  const canSubmit = name.trim() && criterion.trim() && rubric.trim()
  const submit = useCallback(async () => {
    if (!canSubmit) return
    // The set is created lazily on its first item; we hand a FRESH opaque id
    // plus the judge (criterion/rubric) up so AddItemForm can denormalize them.
    // The typed name used to BE the id, so two sets called "judge-v1" merged.
    onCreate({
      setId: newCalibrationSetId(),
      setName: name.trim(),
      criterion: criterion.trim(),
      rubric: rubric.trim(),
    })
    setName("")
    setCriterion("")
    setRubric("")
  }, [canSubmit, name, criterion, rubric, onCreate])

  return (
    <Card className="flex flex-col gap-2 p-3">
      <p className="text-sm font-medium">{t("calibration.newSet")}</p>
      <Input
        aria-label={t("calibration.setName")}
        placeholder={t("calibration.setNamePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Input
        aria-label={t("calibration.criterion")}
        placeholder={t("calibration.criterionPlaceholder")}
        value={criterion}
        onChange={(e) => setCriterion(e.target.value)}
      />
      <Textarea
        aria-label={t("calibration.rubric")}
        placeholder={t("calibration.rubricPlaceholder")}
        value={rubric}
        onChange={(e) => setRubric(e.target.value)}
        rows={2}
      />
      <Button size="sm" disabled={!canSubmit} onClick={submit}>
        <PlusIcon className="size-4" />
        {t("calibration.createSet")}
      </Button>
    </Card>
  )
}

function AddItemForm({
  setId,
  setName,
  criterion,
  rubric,
}: {
  setId: string
  setName: string
  criterion: string
  rubric: string
}) {
  const t = useTranslations("eval")
  const [input, setInput] = useState("")
  const [output, setOutput] = useState("")
  const [reference, setReference] = useState("")
  const [goldLabel, setGold] = useState<CalibrationLabel>("pass")

  const canSubmit = input.trim() && output.trim()
  const submit = useCallback(async () => {
    if (!canSubmit) return
    await upsertCalibrationItem({
      setId,
      setName,
      criterion,
      rubric,
      input: input.trim(),
      output: output.trim(),
      ...(reference.trim() ? { reference: reference.trim() } : {}),
      goldLabel,
      source: "handwritten",
    })
    setInput("")
    setOutput("")
    setReference("")
    setGold("pass")
  }, [canSubmit, setId, setName, criterion, rubric, input, output, reference, goldLabel])

  return (
    <Card className="flex flex-col gap-2 p-3">
      <p className="text-sm font-medium">{t("calibration.addItem")}</p>
      <Textarea
        aria-label={t("calibration.input")}
        placeholder={t("calibration.inputPlaceholder")}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={2}
      />
      <Textarea
        aria-label={t("calibration.output")}
        placeholder={t("calibration.outputPlaceholder")}
        value={output}
        onChange={(e) => setOutput(e.target.value)}
        rows={2}
      />
      <Input
        aria-label={t("calibration.reference")}
        placeholder={t("calibration.referencePlaceholder")}
        value={reference}
        onChange={(e) => setReference(e.target.value)}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-xs">{t("calibration.gold")}:</span>
          <Button
            size="sm"
            variant={goldLabel === "pass" ? "secondary" : "ghost"}
            aria-pressed={goldLabel === "pass"}
            onClick={() => setGold("pass")}
          >
            {t("calibration.goldPass")}
          </Button>
          <Button
            size="sm"
            variant={goldLabel === "fail" ? "secondary" : "ghost"}
            aria-pressed={goldLabel === "fail"}
            onClick={() => setGold("fail")}
          >
            {t("calibration.goldFail")}
          </Button>
        </div>
        <Button size="sm" disabled={!canSubmit} onClick={submit}>
          <PlusIcon className="size-4" />
          {t("calibration.add")}
        </Button>
      </div>
    </Card>
  )
}

function MetricsCard({ run }: { run: CalibrationRunRow }) {
  const t = useTranslations("eval")
  const m: AgreementMetrics = run.metrics
  const cells: { key: string; label: string; value: string }[] = [
    { key: "tp", label: t("calibration.metrics.tp"), value: String(m.matrix.tp) },
    { key: "fp", label: t("calibration.metrics.fp"), value: String(m.matrix.fp) },
    { key: "fn", label: t("calibration.metrics.fn"), value: String(m.matrix.fn) },
    { key: "tn", label: t("calibration.metrics.tn"), value: String(m.matrix.tn) },
  ]
  const rates: { key: string; label: string; value: string }[] = [
    { key: "tpr", label: t("calibration.metrics.tpr"), value: pct(m.tpr) },
    { key: "tnr", label: t("calibration.metrics.tnr"), value: pct(m.tnr) },
    { key: "precision", label: t("calibration.metrics.precision"), value: pct(m.precision) },
    { key: "f1", label: t("calibration.metrics.f1"), value: pct(m.f1) },
    { key: "accuracy", label: t("calibration.metrics.accuracy"), value: pct(m.accuracy) },
  ]
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="calibration-metrics">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{t("calibration.metrics.kappa")}</span>
        <span
          className="text-2xl font-semibold tabular-nums"
          data-testid="kappa-value"
          title={m.cohenKappa === null ? t("calibration.metrics.metricUndefined") : undefined}
        >
          {kappa(m.cohenKappa)}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("calibration.metrics.summary", {
          n: m.n,
          errored: run.erroredCount,
        })}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {cells.map((c) => (
          <div key={c.key} className="rounded-md border p-2 text-center">
            <div className="text-muted-foreground text-[10px] uppercase">{c.label}</div>
            <div className="text-lg font-medium tabular-nums">{c.value}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {rates.map((r) => (
          <Badge key={r.key} variant="secondary" className="text-xs">
            {r.label} {r.value}
          </Badge>
        ))}
      </div>
    </Card>
  )
}

function DisagreementList({ run }: { run: CalibrationRunRow }) {
  const t = useTranslations("eval")
  const disagreements = useMemo(
    () => run.verdicts.filter((v) => !v.errored && (v.goldLabel === "pass") !== v.judgePassed),
    [run.verdicts]
  )
  return (
    <Card className="flex flex-col gap-2 p-4">
      <p className="text-sm font-medium">{t("calibration.disagreement.heading")}</p>
      {disagreements.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("calibration.disagreement.empty")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {disagreements.map((v) => (
            <div
              key={v.itemId}
              className="rounded-md border p-2 text-xs"
              data-testid="disagreement"
            >
              <div className="flex gap-3">
                <span>
                  {t("calibration.disagreement.humanSaid")}:{" "}
                  <strong>
                    {t(`calibration.${v.goldLabel === "pass" ? "goldPass" : "goldFail"}`)}
                  </strong>
                </span>
                <span>
                  {t("calibration.disagreement.judgeSaid")}:{" "}
                  <strong>{t(`calibration.${v.judgePassed ? "goldPass" : "goldFail"}`)}</strong>
                </span>
              </div>
              {v.reasoning && (
                <p className="text-muted-foreground mt-1">
                  {t("calibration.disagreement.reasoning")}: {v.reasoning}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

/**
 * κ over time — the point of keeping calibration history at all.
 *
 * This was a flat row of badges in whatever order the query returned, with no
 * time axis and no judge attribution, so "did the judge get worse when we
 * changed the rubric?" — the question the history exists to answer — could not
 * be read off it. Now: oldest → newest, with the judge model that produced each
 * point and the change from the previous one.
 *
 * A bar chart rather than a charting library: κ is a bounded [-1, 1] scalar
 * over a handful of points, and the repo's chart dependency is not worth
 * pulling into a panel that shows at most a few dozen bars.
 */
function HistoryStrip({ runs }: { runs: CalibrationRunRow[] }) {
  const t = useTranslations("eval")
  // Oldest first: a trend read right-to-left is not a trend.
  const ordered = useMemo(() => [...runs].sort((a, b) => a.createdAt - b.createdAt), [runs])
  if (ordered.length === 0) return null

  return (
    <Card className="flex flex-col gap-2 p-4" data-testid="kappa-history">
      <p className="text-sm font-medium">{t("calibration.history.heading")}</p>
      <ul className="flex flex-col gap-1">
        {ordered.map((r, i) => {
          const k = r.metrics.cohenKappa
          const prev = i > 0 ? ordered[i - 1].metrics.cohenKappa : null
          const delta = k !== null && prev !== null ? k - prev : null
          // κ spans [-1, 1]; map it onto a 0-100% bar so negative agreement is
          // visibly different from "no data" rather than both rendering empty.
          const width = k === null ? 0 : ((k + 1) / 2) * 100
          return (
            <li key={r.runId} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground w-28 shrink-0 truncate">
                {new Date(r.createdAt).toLocaleDateString()}
              </span>
              <span className="bg-muted h-2 min-w-0 flex-1 overflow-hidden rounded">
                <span
                  className={cn(
                    "block h-full",
                    k !== null && k < 0 ? "bg-destructive" : "bg-primary"
                  )}
                  style={{ width: `${width}%` }}
                />
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">κ {kappa(k)}</span>
              <span
                className={cn(
                  "w-12 shrink-0 text-right tabular-nums",
                  delta === null
                    ? "text-muted-foreground"
                    : delta < 0
                      ? "text-destructive"
                      : "text-muted-foreground"
                )}
              >
                {delta === null ? DASH : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`}
              </span>
              <span className="text-muted-foreground w-32 shrink-0 truncate" title={r.judgeModel}>
                {r.judgeModel}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="text-muted-foreground text-xs">{t("calibration.history.hint")}</p>
    </Card>
  )
}

export function CalibrationPanel() {
  const t = useTranslations("eval")
  const appSettings = useSettingsStore((s) => s.settings)
  const sets = useCalibrationSets()
  const [activeSetId, setActiveSetId] = useState<string | undefined>(undefined)
  const [pendingSet, setPendingSet] = useState<{
    setId: string
    setName: string
    criterion: string
    rubric: string
  } | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const effectiveSetId = activeSetId ?? sets[0]?.setId ?? pendingSet?.setId
  const items = useCalibrationItems(effectiveSetId)
  const latestRun = useLatestCalibrationRun(effectiveSetId)
  const runs = useCalibrationRuns(effectiveSetId)

  const duplicateNames = useMemo(() => {
    const seen = new Set<string>()
    const dupes = new Set<string>()
    for (const s of sets) {
      if (seen.has(s.setName)) dupes.add(s.setName)
      seen.add(s.setName)
    }
    return dupes
  }, [sets])

  const activeSet = sets.find((s) => s.setId === effectiveSetId)
  // A brand-new set has no items yet; carry its name/criterion/rubric from the form.
  const setName = activeSet?.setName ?? pendingSet?.setName ?? ""
  const criterion = activeSet?.criterion ?? pendingSet?.criterion ?? ""
  const rubric = activeSet?.rubric ?? pendingSet?.rubric ?? ""

  const handleRun = useCallback(async () => {
    if (!effectiveSetId) return
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: items.length })
    // The runner has always accepted a signal; the panel simply never passed
    // one, so a calibration run over a large set could not be stopped.
    const controller = new AbortController()
    abortRef.current = controller
    try {
      await runCalibration({
        setId: effectiveSetId,
        appSettings,
        signal: controller.signal,
        onProgress: setProgress,
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Cancelling is not a failure; the runner persists nothing.
      } else {
        setError(
          err instanceof CalibrationNoJudgeError
            ? t("calibration.noJudge")
            : err instanceof Error
              ? err.message
              : String(err)
        )
      }
    } finally {
      setRunning(false)
      setProgress(null)
      abortRef.current = null
    }
  }, [effectiveSetId, items.length, appSettings, t])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <header className="flex items-center gap-2">
        <ScaleIcon className="size-5" />
        <div>
          <h1 className="text-lg font-semibold">{t("calibration.heading")}</h1>
          <p className="text-muted-foreground text-sm">{t("calibration.subtitle")}</p>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm">
          {t("calibration.pickSet")}{" "}
          <NativeSelect
            aria-label={t("calibration.pickSet")}
            size="sm"
            value={effectiveSetId ?? ""}
            onChange={(e) => setActiveSetId(e.target.value || undefined)}
          >
            {pendingSet && !sets.some((s) => s.setId === pendingSet.setId) && (
              <NativeSelectOption value={pendingSet.setId}>{pendingSet.setName}</NativeSelectOption>
            )}
            {sets.map((s) => (
              <NativeSelectOption key={s.setId} value={s.setId}>
                {/* Names may repeat now that they are not identity; the id
                    suffix disambiguates rather than merging them. */}
                {duplicateNames.has(s.setName)
                  ? `${s.setName} (${s.setId.slice(-6)}) · ${s.itemCount}`
                  : `${s.setName} · ${s.itemCount}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <Button
          size="sm"
          disabled={!effectiveSetId || items.length === 0 || running}
          onClick={handleRun}
        >
          <PlayIcon className="size-4" />
          {running ? t("calibration.running") : t("calibration.run")}
        </Button>
        {progress && (
          <span className="text-muted-foreground text-xs" role="status">
            {progress.done}/{progress.total}
          </span>
        )}
        {running && (
          <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
            {t("calibration.cancel")}
          </Button>
        )}
        {error && (
          <span className="text-destructive text-xs" role="alert">
            {error}
          </span>
        )}
      </div>

      {activeSet?.criterionMismatch && (
        <p className="text-destructive text-xs" role="alert" data-testid="criterion-mismatch">
          {t("calibration.criterionMismatch", { criterion: activeSet.criterion })}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <NewSetForm
            onCreate={(next) => {
              setActiveSetId(next.setId)
              setPendingSet(next)
            }}
          />
          {effectiveSetId && (
            <AddItemForm
              setId={effectiveSetId}
              setName={setName}
              criterion={criterion}
              rubric={rubric}
            />
          )}
          {items.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("calibration.empty")}</p>
          ) : (
            items.map((item) => <ItemRow key={item.id} item={item} />)
          )}
        </div>

        <div className="flex flex-col gap-3">
          {latestRun ? (
            <>
              <MetricsCard run={latestRun} />
              <DisagreementList run={latestRun} />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">{t("calibration.noRun")}</p>
          )}
          <HistoryStrip runs={runs} />
        </div>
      </div>
    </div>
  )
}
