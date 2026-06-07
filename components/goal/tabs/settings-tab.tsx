"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import type { Goal, GoalConfig } from "@/types/goal"
import { getGoalRuntime } from "@/lib/goal/runtime"
import { isTerminalGoalStatus } from "@/types/goal"

interface Props {
  goal: Goal
}

/**
 * Per-goal config editor — surfaces the four knobs from `GoalConfig` plus
 * the optional inline stop condition. Changes don't rotate the
 * generationId (config tweaks shouldn't invalidate the in-flight judge).
 *
 * Disabled for terminal goals — once a goal ended, its config is
 * historical record only.
 */
export function GoalSettingsTab({ goal }: Props) {
  const t = useTranslations("goal")
  const disabled = isTerminalGoalStatus(goal.status)
  // Use React's official "storing information from previous renders" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders):
  // when the bound goal id changes (user navigated to a different goal),
  // reset the draft. Cleaner than `useEffect(() => setDraft)` and dodges
  // both the set-state-in-effect and refs-in-render lint rules.
  const [draft, setDraft] = useState<GoalConfig>(goal.config)
  const [boundGoalId, setBoundGoalId] = useState(goal.id)
  if (boundGoalId !== goal.id) {
    setBoundGoalId(goal.id)
    setDraft(goal.config)
  }
  const [saving, setSaving] = useState(false)

  const dirty =
    draft.maxTurns !== goal.config.maxTurns ||
    draft.maxTokens !== goal.config.maxTokens ||
    draft.maxJudgeFailures !== goal.config.maxJudgeFailures ||
    draft.timeoutMs !== goal.config.timeoutMs ||
    (draft.inlineStopCondition ?? "") !== (goal.config.inlineStopCondition ?? "") ||
    (draft.completionPromise ?? "") !== (goal.config.completionPromise ?? "") ||
    (draft.maxPromiseDenials ?? 3) !== (goal.config.maxPromiseDenials ?? 3) ||
    (draft.adaptivePacing ?? false) !== (goal.config.adaptivePacing ?? false)

  async function handleSave() {
    if (!dirty || disabled) return
    setSaving(true)
    try {
      await getGoalRuntime().updateConfig(goal.id, {
        maxTurns: Math.max(1, draft.maxTurns),
        maxTokens: Math.max(1000, draft.maxTokens),
        maxJudgeFailures: Math.max(1, draft.maxJudgeFailures),
        timeoutMs: Math.max(60_000, draft.timeoutMs),
        inlineStopCondition: draft.inlineStopCondition?.trim() || undefined,
        completionPromise: draft.completionPromise?.trim() || undefined,
        maxPromiseDenials: Math.max(1, draft.maxPromiseDenials ?? 3),
        adaptivePacing: draft.adaptivePacing || undefined,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 text-sm" data-testid="goal-settings-form">
      <Field label={t("config.maxTurns")} hint={t("config.maxTurnsHint")}>
        <Input
          type="number"
          min={1}
          max={100}
          value={draft.maxTurns}
          disabled={disabled}
          onChange={(e) =>
            setDraft({ ...draft, maxTurns: Number(e.target.value) || draft.maxTurns })
          }
          data-testid="goal-config-max-turns"
        />
      </Field>
      <Field label={t("config.maxTokens")} hint={t("config.maxTokensHint")}>
        <Input
          type="number"
          min={1000}
          value={draft.maxTokens}
          disabled={disabled}
          onChange={(e) =>
            setDraft({ ...draft, maxTokens: Number(e.target.value) || draft.maxTokens })
          }
          data-testid="goal-config-max-tokens"
        />
      </Field>
      <Field label={t("config.maxJudgeFailures")} hint={t("config.maxJudgeFailuresHint")}>
        <Input
          type="number"
          min={1}
          max={10}
          value={draft.maxJudgeFailures}
          disabled={disabled}
          onChange={(e) =>
            setDraft({
              ...draft,
              maxJudgeFailures: Number(e.target.value) || draft.maxJudgeFailures,
            })
          }
          data-testid="goal-config-max-judge-failures"
        />
      </Field>
      <Field label={t("config.timeout")} hint={t("config.timeoutHint")}>
        <Input
          type="number"
          min={1}
          value={Math.round(draft.timeoutMs / 60_000)}
          disabled={disabled}
          onChange={(e) =>
            setDraft({
              ...draft,
              timeoutMs: (Number(e.target.value) || Math.round(draft.timeoutMs / 60_000)) * 60_000,
            })
          }
          data-testid="goal-config-timeout"
        />
      </Field>
      <Field label={t("config.inlineStop")} hint={t("config.inlineStopHint")}>
        <Input
          type="text"
          value={draft.inlineStopCondition ?? ""}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, inlineStopCondition: e.target.value })}
          data-testid="goal-config-inline-stop"
        />
      </Field>
      <Field label={t("config.completionPromise")} hint={t("config.completionPromiseHint")}>
        <Input
          type="text"
          value={draft.completionPromise ?? ""}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, completionPromise: e.target.value })}
          data-testid="goal-config-completion-promise"
        />
      </Field>
      <Field label={t("config.maxPromiseDenials")} hint={t("config.maxPromiseDenialsHint")}>
        <Input
          type="number"
          min={1}
          max={10}
          value={draft.maxPromiseDenials ?? 3}
          disabled={disabled}
          onChange={(e) =>
            setDraft({
              ...draft,
              maxPromiseDenials: Number(e.target.value) || (draft.maxPromiseDenials ?? 3),
            })
          }
          data-testid="goal-config-max-promise-denials"
        />
      </Field>
      <Field label={t("config.adaptivePacing")} hint={t("config.adaptivePacingHint")}>
        <div className="pt-1">
          <Switch
            checked={draft.adaptivePacing ?? false}
            disabled={disabled}
            onCheckedChange={(checked) => setDraft({ ...draft, adaptivePacing: checked })}
            aria-label={t("config.adaptivePacing")}
            data-testid="goal-config-adaptive-pacing"
          />
        </div>
      </Field>
      <div className="flex justify-end pt-2">
        <Button
          disabled={!dirty || disabled || saving}
          onClick={() => void handleSave()}
          data-testid="goal-config-save"
        >
          {saving ? t("config.saving") : t("config.save")}
        </Button>
      </div>
    </div>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <Label className="text-xs font-medium">{label}</Label>
      {children}
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
