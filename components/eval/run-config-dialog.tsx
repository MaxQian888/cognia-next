"use client"

/**
 * Run configuration: build an {@link EvalRunConfig} (target matrix × scorer
 * subset × k × case subset) and launch it via the configured matrix runner.
 * Replaces the dashboard's hardcoded single-chat-run button. Target option
 * lists (models / characters / teams / workflows) are passed in by the parent;
 * each falls back to a free-text id input when its list is empty.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon, PlayIcon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AppSettings } from "@/lib/claude/types"
import { buildConfiguredRunDeps } from "@/lib/ai/eval/browser-deps"
import { runConfiguredEval } from "@/lib/ai/eval/run-config"
import type { EvalRunConfig, TargetKind, TargetSpec } from "@/types/eval/run-config"

/** The scorer ids the engine can produce (deterministic + llm tiers). */
export const KNOWN_SCORER_IDS = [
  "tool-selection",
  "tool-args",
  "tool-order",
  "redundancy",
  "trajectory-unordered",
  "assertion",
  "cost",
  "rag-context-recall",
  "judge-task-completion",
  "judge-instruction-following",
  "rag-faithfulness",
  "rag-answer-relevancy",
  "rag-context-precision",
] as const

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
  const defaultModel = appSettings?.defaultModel ?? "claude-opus-4-8"
  const [targets, setTargets] = useState<TargetDraft[]>([
    { kind: "chat", label: "", ref: defaultModel },
  ])
  const [k, setK] = useState(1)
  const [scorerIds, setScorerIds] = useState<string[]>([...KNOWN_SCORER_IDS])
  const [split, setSplit] = useState("")
  const [capabilities, setCapabilities] = useState("")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { deterministicOnly } = useMemo(
    () => buildConfiguredRunDeps({ appSettings }),
    [appSettings]
  )

  const setTarget = (i: number, patch: Partial<TargetDraft>) =>
    setTargets((cur) => cur.map((tg, idx) => (idx === i ? { ...tg, ...patch } : tg)))

  const splitCommas = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)

  const handleRun = useCallback(async () => {
    setRunning(true)
    setError(null)
    try {
      const config: EvalRunConfig = {
        targets: targets.filter((d) => d.ref.trim()).map(draftToSpec),
        scorerIds: scorerIds.length === KNOWN_SCORER_IDS.length ? [] : scorerIds,
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
      const { deps } = buildConfiguredRunDeps({ appSettings })
      const reports = await runConfiguredEval(datasetId, config, deps)
      onComplete?.(reports.length)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [targets, scorerIds, k, split, capabilities, appSettings, datasetId, onClose, onComplete, t])

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

      {/* Scorer subset */}
      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">
          {t("runConfig.scorers", { count: scorerIds.length })}
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {KNOWN_SCORER_IDS.map((id) => (
            <label key={id} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={scorerIds.includes(id)}
                aria-label={id}
                onChange={() =>
                  setScorerIds((cur) =>
                    cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
                  )
                }
              />
              {id}
            </label>
          ))}
        </div>
      </details>

      {deterministicOnly && (
        <p className="text-muted-foreground text-xs">{t("runConfig.deterministicOnly")}</p>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {t("runConfig.failed", { error })}
        </p>
      )}

      <Button onClick={() => void handleRun()} disabled={running}>
        {running ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <PlayIcon className="size-4" />
        )}
        {running ? t("runConfig.running") : t("runConfig.run")}
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
