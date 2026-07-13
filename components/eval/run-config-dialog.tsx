"use client"

/**
 * Run configuration: build an {@link EvalRunConfig} (target matrix × scorer
 * subset × k × case subset) and launch it via the configured matrix runner.
 * Replaces the dashboard's hardcoded single-chat-run button. Target option
 * lists (models / characters / teams / workflows) are passed in by the parent;
 * each falls back to a free-text id input when its list is empty.
 *
 * Defaults (k, scorer selection, judge model, deterministic-only) come from
 * `AppSettings.evalSettings` via {@link resolveEvalSettings}, so the run dialog
 * inherits whatever the user configured under Settings → Agent 评估. A cost
 * estimate (extrapolated from the dataset's most recent run) warns before an
 * expensive matrix when the settings cost guard is set.
 */

import { useCallback, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { PlusIcon, Trash2Icon, PlayIcon, Loader2Icon, ScaleIcon, SettingsIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AppSettings } from "@cognia/agent-config-types"
import { buildConfiguredRunDeps } from "@/lib/ai/eval/browser-deps"
import { runEvalService, type EvalProgress } from "@/lib/ai/eval/service"
import { resolveEvalSettings } from "@/lib/ai/eval/settings"
import { useEvalRuns, useEvalCases } from "@/hooks/eval/use-eval-data"
import type { EvalRunConfig, TargetKind, TargetSpec } from "@/types/eval/run-config"
import { ScorerPicker, expandScorerSelection, normalizeScorerSelection } from "./scorer-picker"

interface NameId {
  id: string
  name: string
}
export interface RunConfigOptions {
  models?: string[]
  characters?: NameId[]
  teams?: NameId[]
  workflows?: NameId[]
}

interface TargetDraft {
  kind: TargetKind
  label: string
  /** model (chat) | teamId (team) | workflowId (workflow). */
  ref: string
  characterId?: string
}

function draftToSpec(d: TargetDraft): TargetSpec {
  const label = d.label.trim() || d.ref || d.kind
  if (d.kind === "chat") {
    return {
      kind: "chat",
      label,
      model: d.ref,
      ...(d.characterId ? { characterId: d.characterId } : {}),
    }
  }
  if (d.kind === "team") return { kind: "team", label, teamId: d.ref }
  return { kind: "workflow", label, workflowId: d.ref }
}

export interface RunConfigDialogProps {
  datasetId: string
  appSettings: AppSettings | null
  options?: RunConfigOptions
  onClose: () => void
  onComplete?: (runCount: number) => void
}

export function RunConfigDialog({
  datasetId,
  appSettings,
  options = {},
  onClose,
  onComplete,
}: RunConfigDialogProps) {
  const t = useTranslations("eval")
  const router = useRouter()
  const evalSettings = useMemo(() => resolveEvalSettings(appSettings), [appSettings])
  const defaultModel = appSettings?.defaultModel ?? "claude-opus-4-8"

  const [targets, setTargets] = useState<TargetDraft[]>([
    { kind: "chat", label: "", ref: defaultModel },
  ])
  const [k, setK] = useState(evalSettings.defaultK)
  const [scorerIds, setScorerIds] = useState<string[]>(() =>
    expandScorerSelection(evalSettings.defaultScorerIds)
  )
  const [split, setSplit] = useState("")
  const [capabilities, setCapabilities] = useState("")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<EvalProgress | null>(null)
  const [costAck, setCostAck] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const { deterministicOnly } = useMemo(
    () =>
      buildConfiguredRunDeps({
        appSettings,
        ...(evalSettings.deterministicOnly ? { forceDeterministic: true } : {}),
        ...(evalSettings.judgeModel ? { judgeModel: evalSettings.judgeModel } : {}),
      }),
    [appSettings, evalSettings.deterministicOnly, evalSettings.judgeModel]
  )

  // Cost estimate: extrapolate the dataset's most recent run's per-(case×rep)
  // cost across the current case count × k × target count. An upper bound (it
  // ignores the case subset), which is the safe side for a "this may be pricey"
  // warning. Null until the dataset has at least one prior run.
  const datasetRuns = useEvalRuns(datasetId)
  const cases = useEvalCases(datasetId)
  const costPerUnit = useMemo(() => {
    let last: (typeof datasetRuns)[number] | undefined
    for (const r of datasetRuns) if (!last || r.createdAt > last.createdAt) last = r
    if (!last) return null
    return last.totalCostUsd / Math.max(1, last.caseCount * last.k)
  }, [datasetRuns])

  const targetCount = Math.max(1, targets.filter((d) => d.ref.trim()).length)
  const estimatedCost =
    costPerUnit != null
      ? costPerUnit * Math.max(1, cases.length) * Math.max(1, k) * targetCount
      : null
  const costWarnUsd = evalSettings.costWarnUsd
  const overBudget =
    estimatedCost != null && costWarnUsd != null && costWarnUsd > 0 && estimatedCost > costWarnUsd

  const setTarget = (i: number, patch: Partial<TargetDraft>) =>
    setTargets((cur) => cur.map((tg, idx) => (idx === i ? { ...tg, ...patch } : tg)))

  const splitCommas = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

  const handleRun = useCallback(async () => {
    // First click while over the cost guard: acknowledge, don't run yet.
    if (overBudget && !costAck) {
      setCostAck(true)
      return
    }
    setRunning(true)
    setError(null)
    setProgress(null)
    try {
      const config: EvalRunConfig = {
        targets: targets.filter((d) => d.ref.trim()).map(draftToSpec),
        scorerIds: normalizeScorerSelection(scorerIds),
        k: Math.max(1, k),
        ...(split.trim() || capabilities.trim()
          ? {
              subset: {
                ...(split.trim() ? { split: split.trim() } : {}),
                ...(capabilities.trim() ? { capabilities: splitCommas(capabilities) } : {}),
              },
            }
          : {}),
      }
      if (config.targets.length === 0) {
        setError(t("runConfig.noTargets"))
        return
      }
      const controller = new AbortController()
      abortRef.current = controller
      const { reports } = await runEvalService({
        datasetId,
        config,
        appSettings,
        signal: controller.signal,
        ...(evalSettings.deterministicOnly ? { forceDeterministic: true } : {}),
        ...(evalSettings.judgeModel ? { judgeModel: evalSettings.judgeModel } : {}),
        onProgress: (p) => setProgress(p),
      })
      onComplete?.(reports.length)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [
    overBudget,
    costAck,
    targets,
    scorerIds,
    k,
    split,
    capabilities,
    appSettings,
    datasetId,
    evalSettings.deterministicOnly,
    evalSettings.judgeModel,
    onClose,
    onComplete,
    t,
  ])

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="run-config-dialog">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("runConfig.heading")}</h3>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("runConfig.close")}
        </Button>
      </div>

      {/* Target matrix */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t("runConfig.targets")}</span>
        {targets.map((d, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <select
              aria-label={t("runConfig.targetKind")}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={d.kind}
              onChange={(e) => setTarget(i, { kind: e.target.value as TargetKind, ref: "" })}
            >
              <option value="chat">{t("runConfig.kind.chat")}</option>
              <option value="team">{t("runConfig.kind.team")}</option>
              <option value="workflow">{t("runConfig.kind.workflow")}</option>
            </select>
            <RefField
              kind={d.kind}
              value={d.ref}
              options={options}
              onChange={(v) => setTarget(i, { ref: v })}
              label={t("runConfig.targetRef")}
            />
            {d.kind === "chat" && (options.characters?.length ?? 0) > 0 && (
              <select
                aria-label={t("runConfig.character")}
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={d.characterId ?? ""}
                onChange={(e) => setTarget(i, { characterId: e.target.value || undefined })}
              >
                <option value="">{t("runConfig.defaultCharacter")}</option>
                {options.characters!.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
            <Input
              aria-label={t("runConfig.targetLabel")}
              placeholder={t("runConfig.targetLabel")}
              value={d.label}
              onChange={(e) => setTarget(i, { label: e.target.value })}
              className="h-8 w-32"
            />
            {targets.length > 1 && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("runConfig.removeTarget")}
                onClick={() => setTargets((cur) => cur.filter((_, idx) => idx !== i))}
              >
                <Trash2Icon className="size-4" />
              </Button>
            )}
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            setTargets((cur) => [...cur, { kind: "chat", label: "", ref: defaultModel }])
          }
        >
          <PlusIcon className="size-4" />
          {t("runConfig.addTarget")}
        </Button>
      </div>

      {/* k + subset */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>{t("runConfig.k")}</span>
          <Input
            type="number"
            min={1}
            aria-label={t("runConfig.k")}
            value={k}
            onChange={(e) => setK(Number(e.target.value) || 1)}
          />
        </label>
        <Input
          aria-label={t("runConfig.split")}
          placeholder={t("runConfig.split")}
          value={split}
          onChange={(e) => setSplit(e.target.value)}
        />
        <Input
          aria-label={t("runConfig.capabilities")}
          placeholder={t("runConfig.capabilities")}
          value={capabilities}
          onChange={(e) => setCapabilities(e.target.value)}
        />
      </div>

      {/* Judge indicator + link to settings */}
      <div className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <ScaleIcon className="size-3.5 shrink-0" />
          <span className="truncate">
            {deterministicOnly
              ? t("judge.deterministic")
              : t("judge.using", { model: evalSettings.judgeModel ?? t("judge.auto") })}
          </span>
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 gap-1 px-2"
          onClick={() => router.push("/settings?section=eval")}
        >
          <SettingsIcon className="size-3.5" />
          {t("judge.configure")}
        </Button>
      </div>

      {/* Scorer subset — grouped by dimension */}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">
          {t("runConfig.scorers", { count: scorerIds.length })}
        </span>
        <ScorerPicker
          value={scorerIds}
          onChange={setScorerIds}
          judgeAvailable={!deterministicOnly}
        />
      </div>

      {deterministicOnly && (
        <p className="text-muted-foreground text-xs">{t("runConfig.deterministicOnly")}</p>
      )}

      {estimatedCost != null && (
        <p className={cn("text-xs", overBudget ? "text-destructive" : "text-muted-foreground")}>
          {t("cost.estimate", { cost: estimatedCost.toFixed(2) })}
          {overBudget && costWarnUsd != null
            ? ` — ${t("cost.overBudget", { budget: costWarnUsd.toFixed(2) })}`
            : ""}
        </p>
      )}

      {running && progress && (
        <div className="flex items-center gap-2" data-testid="run-progress">
          <progress
            className="h-2 min-w-0 flex-1"
            value={progress.done}
            max={progress.total}
            aria-label={t("runConfig.progressLabel")}
          />
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("runConfig.progress", {
              done: progress.done,
              total: progress.total,
              passing: progress.passing,
            })}
          </span>
          <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}>
            {t("runConfig.cancelRun")}
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {t("runConfig.failed", { error })}
        </p>
      )}

      <Button
        onClick={() => void handleRun()}
        disabled={running}
        variant={overBudget && !costAck ? "destructive" : "default"}
      >
        {running ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <PlayIcon className="size-4" />
        )}
        {running
          ? t("runConfig.running")
          : overBudget && !costAck
            ? t("runConfig.runAnyway")
            : t("runConfig.run")}
      </Button>
    </div>
  )
}

function RefField({
  kind,
  value,
  options,
  onChange,
  label,
}: {
  kind: TargetKind
  value: string
  options: RunConfigOptions
  onChange: (v: string) => void
  label: string
}) {
  const list =
    kind === "chat"
      ? (options.models ?? []).map((m) => ({ id: m, name: m }))
      : kind === "team"
        ? (options.teams ?? [])
        : (options.workflows ?? [])
  if (list.length > 0) {
    return (
      <select
        aria-label={label}
        className="rounded-md border bg-background px-2 py-1 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {list.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    )
  }
  return (
    <Input
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-44"
    />
  )
}
