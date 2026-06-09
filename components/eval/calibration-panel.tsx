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

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ScaleIcon, PlayIcon, Trash2Icon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  useCalibrationSets,
  useCalibrationItems,
  useCalibrationRuns,
  useLatestCalibrationRun,
} from "@/hooks/eval/use-eval-data"
import {
  upsertCalibrationItem,
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
  onCreate: (setId: string, criterion: string, rubric: string) => void
}) {
  const t = useTranslations("eval")
  const [name, setName] = useState("")
  const [criterion, setCriterion] = useState("")
  const [rubric, setRubric] = useState("")

  const canSubmit = name.trim() && criterion.trim() && rubric.trim()
  const submit = useCallback(async () => {
    if (!canSubmit) return
    // The set is created lazily on its first item; we hand the id + the judge
    // (criterion/rubric) up so the AddItemForm can denormalize them onto items.
    onCreate(name.trim(), criterion.trim(), rubric.trim())
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
  criterion,
  rubric,
}: {
  setId: string
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
  }, [canSubmit, setId, criterion, rubric, input, output, reference, goldLabel])

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

function HistoryStrip({ runs }: { runs: CalibrationRunRow[] }) {
  const t = useTranslations("eval")
  if (runs.length === 0) return null
  return (
    <Card className="flex flex-col gap-1 p-4">
      <p className="text-sm font-medium">{t("calibration.history.heading")}</p>
      <div className="flex flex-wrap gap-2">
        {runs.map((r) => (
          <Badge key={r.runId} variant="outline" className="text-xs tabular-nums">
            κ {kappa(r.metrics.cohenKappa)}
          </Badge>
        ))}
      </div>
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
    criterion: string
    rubric: string
  } | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const effectiveSetId = activeSetId ?? sets[0]?.setId ?? pendingSet?.setId
  const items = useCalibrationItems(effectiveSetId)
  const latestRun = useLatestCalibrationRun(effectiveSetId)
  const runs = useCalibrationRuns(effectiveSetId)

  const activeSet = sets.find((s) => s.setId === effectiveSetId)
  // A brand-new set has no items yet; carry its criterion/rubric from the form.
  const criterion = activeSet?.criterion ?? pendingSet?.criterion ?? ""
  const rubric = activeSet?.rubric ?? pendingSet?.rubric ?? ""

  const handleRun = useCallback(async () => {
    if (!effectiveSetId) return
    setRunning(true)
    setError(null)
    setProgress({ done: 0, total: items.length })
    try {
      await runCalibration({
        setId: effectiveSetId,
        appSettings,
        onProgress: setProgress,
      })
    } catch (err) {
      setError(
        err instanceof CalibrationNoJudgeError
          ? t("calibration.noJudge")
          : err instanceof Error
            ? err.message
            : String(err)
      )
    } finally {
      setRunning(false)
      setProgress(null)
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
          <select
            aria-label={t("calibration.pickSet")}
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={effectiveSetId ?? ""}
            onChange={(e) => setActiveSetId(e.target.value || undefined)}
          >
            {pendingSet && !sets.some((s) => s.setId === pendingSet.setId) && (
              <option value={pendingSet.setId}>{pendingSet.setId}</option>
            )}
            {sets.map((s) => (
              <option key={s.setId} value={s.setId}>
                {s.setId} · {s.itemCount}
              </option>
            ))}
          </select>
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
        {error && (
          <span className="text-destructive text-xs" role="alert">
            {error}
          </span>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <NewSetForm
            onCreate={(setId, newCriterion, newRubric) => {
              setActiveSetId(setId)
              setPendingSet({ setId, criterion: newCriterion, rubric: newRubric })
            }}
          />
          {effectiveSetId && (
            <AddItemForm setId={effectiveSetId} criterion={criterion} rubric={rubric} />
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
