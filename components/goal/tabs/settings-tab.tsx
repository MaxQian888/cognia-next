"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { GoalVerificationWorkflowPicker } from "@/components/goal/goal-verification-workflow-picker"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import type { Goal, GoalConfig } from "@/types/goal"
import { useGoalControls } from "@/hooks/goal/use-goal-controls"
import { isTerminalGoalStatus } from "@/types/goal"
import { toast } from "sonner"

interface Props {
  goal: Goal
}

/**
 * Per-goal config editor — every `GoalConfig` knob, grouped the way the
 * defaults form groups them (budget, judge, completion gate, pacing) as
 * label ↔ control rows on the card-free settings primitives. Changes don't
 * rotate the generationId (config tweaks shouldn't invalidate the in-flight
 * judge). Save and Discard stick to the bottom of the scroll region; a save
 * confirms or explains its failure.
 *
 * The inspector passes the live goal row, so "unsaved" compares against what
 * is stored now, not against the snapshot the sheet was opened with.
 *
 * Read-only for terminal goals — once a goal ended, its config is
 * historical record only.
 *
 * Every write goes through `useGoalControls`, so on a paired phone the whole
 * form — the verifier included — reaches the desktop: saves over
 * `goal_update` (an explicit null verifier removes it), the verifier retry
 * over `goal_verify_retry`, and the verifier options are the desktop's.
 */
export function GoalSettingsTab({ goal }: Props) {
  const t = useTranslations("goal")
  const controls = useGoalControls(goal)
  // Read-only once the goal ended, and on a paired phone without the
  // remote-control grant (saves travel over `goal_update` there).
  const disabled = isTerminalGoalStatus(goal.status) || !controls.allowed
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
  const [retryingVerification, setRetryingVerification] = useState(false)

  const dirty =
    draft.maxTurns !== goal.config.maxTurns ||
    draft.maxTokens !== goal.config.maxTokens ||
    draft.maxJudgeFailures !== goal.config.maxJudgeFailures ||
    draft.timeoutMs !== goal.config.timeoutMs ||
    (draft.inlineStopCondition ?? "") !== (goal.config.inlineStopCondition ?? "") ||
    (draft.completionPromise ?? "") !== (goal.config.completionPromise ?? "") ||
    (draft.maxPromiseDenials ?? 3) !== (goal.config.maxPromiseDenials ?? 3) ||
    (draft.adaptivePacing ?? false) !== (goal.config.adaptivePacing ?? false) ||
    (draft.requireAcceptance ?? false) !== (goal.config.requireAcceptance ?? false) ||
    (draft.riskGating ?? true) !== (goal.config.riskGating ?? true) ||
    (draft.maxBudgetUsd ?? 0) !== (goal.config.maxBudgetUsd ?? 0) ||
    JSON.stringify(draft.verificationWorkflow) !== JSON.stringify(goal.config.verificationWorkflow)

  const [confirmDisableVerification, setConfirmDisableVerification] = useState(false)

  async function persist() {
    setSaving(true)
    try {
      if (goal.config.verificationWorkflow && !draft.verificationWorkflow) {
        // A failure was already reported by the hook.
        if (!(await controls.disableVerification())) return
      } else {
        const ok = await controls.updateConfig({
          maxTurns: Math.max(1, draft.maxTurns),
          maxTokens: Math.max(1000, draft.maxTokens),
          maxJudgeFailures: Math.max(1, draft.maxJudgeFailures),
          timeoutMs: Math.max(60_000, draft.timeoutMs),
          inlineStopCondition: draft.inlineStopCondition?.trim() || undefined,
          completionPromise: draft.completionPromise?.trim() || undefined,
          maxPromiseDenials: Math.max(1, draft.maxPromiseDenials ?? 3),
          adaptivePacing: draft.adaptivePacing || undefined,
          requireAcceptance: draft.requireAcceptance || undefined,
          // Default is ON, so only an explicit opt-out is worth persisting.
          riskGating: draft.riskGating === false ? false : undefined,
          maxBudgetUsd:
            draft.maxBudgetUsd && draft.maxBudgetUsd > 0 ? draft.maxBudgetUsd : undefined,
          verificationWorkflow: draft.verificationWorkflow,
        })
        // A failure was already reported by the hook.
        if (!ok) return
      }
      toast.success(t("config.saved"))
    } catch (error) {
      toast.error(t("config.saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  function handleSave() {
    if (!dirty || disabled) return
    // Removing the verifier resumes the goal and drops the pending completion
    // candidate — worth a real dialog, not `window.confirm`.
    if (goal.config.verificationWorkflow && !draft.verificationWorkflow) {
      setConfirmDisableVerification(true)
      return
    }
    void persist()
  }

  const numberClass = "w-28 tabular-nums"

  return (
    <div className="space-y-5 text-sm" data-testid="goal-settings-form">
      {disabled ? (
        <p className="text-xs text-muted-foreground" data-testid="goal-settings-readonly">
          {t("config.readOnly")}
        </p>
      ) : null}
      <SettingsStack>
        <SettingsBlock title={t("defaults.budgetHeading")}>
          <SettingsField
            htmlFor="goal-config-max-turns"
            label={t("config.maxTurns")}
            description={t("config.maxTurnsHint")}
          >
            <Input
              id="goal-config-max-turns"
              type="number"
              min={1}
              max={100}
              className={numberClass}
              value={draft.maxTurns}
              disabled={disabled}
              onChange={(e) =>
                setDraft({ ...draft, maxTurns: Number(e.target.value) || draft.maxTurns })
              }
              data-testid="goal-config-max-turns"
            />
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-max-tokens"
            label={t("config.maxTokens")}
            description={t("config.maxTokensHint")}
          >
            <Input
              id="goal-config-max-tokens"
              type="number"
              min={1000}
              className={numberClass}
              value={draft.maxTokens}
              disabled={disabled}
              onChange={(e) =>
                setDraft({ ...draft, maxTokens: Number(e.target.value) || draft.maxTokens })
              }
              data-testid="goal-config-max-tokens"
            />
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-max-budget-usd"
            label={t("config.maxBudgetUsd")}
            description={t("config.maxBudgetUsdHint")}
          >
            <Input
              id="goal-config-max-budget-usd"
              type="number"
              min={0}
              step={0.5}
              className={numberClass}
              value={draft.maxBudgetUsd ?? 0}
              disabled={disabled}
              onChange={(e) =>
                setDraft({ ...draft, maxBudgetUsd: Math.max(0, Number(e.target.value) || 0) })
              }
              data-testid="goal-config-max-budget-usd"
            />
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-timeout"
            label={t("config.timeout")}
            description={t("config.timeoutHint")}
          >
            <Input
              id="goal-config-timeout"
              type="number"
              min={1}
              className={numberClass}
              value={Math.round(draft.timeoutMs / 60_000)}
              disabled={disabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  timeoutMs:
                    (Number(e.target.value) || Math.round(draft.timeoutMs / 60_000)) * 60_000,
                })
              }
              data-testid="goal-config-timeout"
            />
          </SettingsField>
        </SettingsBlock>

        <SettingsBlock title={t("judge.heading")}>
          <SettingsField
            htmlFor="goal-config-max-judge-failures"
            label={t("config.maxJudgeFailures")}
            description={t("config.maxJudgeFailuresHint")}
          >
            <Input
              id="goal-config-max-judge-failures"
              type="number"
              min={1}
              max={10}
              className={numberClass}
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
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-inline-stop"
            label={t("config.inlineStop")}
            description={t("config.inlineStopHint")}
            stacked
          >
            <Input
              id="goal-config-inline-stop"
              type="text"
              value={draft.inlineStopCondition ?? ""}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, inlineStopCondition: e.target.value })}
              data-testid="goal-config-inline-stop"
            />
          </SettingsField>
        </SettingsBlock>

        <SettingsBlock title={t("defaults.completionHeading")}>
          <SettingsField
            htmlFor="goal-config-completion-promise"
            label={t("config.completionPromise")}
            description={t("config.completionPromiseHint")}
            stacked
          >
            <Input
              id="goal-config-completion-promise"
              type="text"
              value={draft.completionPromise ?? ""}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, completionPromise: e.target.value })}
              data-testid="goal-config-completion-promise"
            />
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-max-promise-denials"
            label={t("config.maxPromiseDenials")}
            description={t("config.maxPromiseDenialsHint")}
          >
            <Input
              id="goal-config-max-promise-denials"
              type="number"
              min={1}
              max={10}
              className={numberClass}
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
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-require-acceptance"
            label={t("config.requireAcceptance")}
            description={t("config.requireAcceptanceHint")}
          >
            <Switch
              id="goal-config-require-acceptance"
              checked={draft.requireAcceptance ?? false}
              disabled={disabled}
              onCheckedChange={(checked) => setDraft({ ...draft, requireAcceptance: checked })}
              aria-label={t("config.requireAcceptance")}
              data-testid="goal-config-require-acceptance"
            />
          </SettingsField>
          <SettingsField
            label={t("config.verification.label")}
            description={t("config.verification.hint")}
            stacked
          >
            <GoalVerificationWorkflowPicker
              value={draft.verificationWorkflow}
              disabled={disabled}
              onChange={(verificationWorkflow) => setDraft({ ...draft, verificationWorkflow })}
            />
            {goal.verification && ["failed", "error"].includes(goal.verification.status) ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={retryingVerification || !draft.verificationWorkflow || !controls.allowed}
                onClick={() => {
                  setRetryingVerification(true)
                  // A failure to run the retry at all was reported by the hook.
                  void controls
                    .retryVerification()
                    .then((answer) => {
                      if (!answer) return
                      if (answer.state === "running") {
                        toast.info(t("config.verification.retryRunning"))
                        return
                      }
                      const { outcome } = answer
                      if (outcome.kind === "passed")
                        toast.success(t("config.verification.retryPassed"))
                      else if (outcome.kind === "failed") toast.error(outcome.result.summary)
                      else if (outcome.kind === "error") toast.error(outcome.error)
                    })
                    .finally(() => setRetryingVerification(false))
                }}
              >
                {retryingVerification
                  ? t("config.verification.retrying")
                  : t("config.verification.retry")}
              </Button>
            ) : null}
          </SettingsField>
        </SettingsBlock>

        <SettingsBlock title={t("pacing.heading")}>
          <SettingsField
            htmlFor="goal-config-adaptive-pacing"
            label={t("config.adaptivePacing")}
            description={t("config.adaptivePacingHint")}
          >
            <Switch
              id="goal-config-adaptive-pacing"
              checked={draft.adaptivePacing ?? false}
              disabled={disabled}
              onCheckedChange={(checked) => setDraft({ ...draft, adaptivePacing: checked })}
              aria-label={t("config.adaptivePacing")}
              data-testid="goal-config-adaptive-pacing"
            />
          </SettingsField>
          <SettingsField
            htmlFor="goal-config-risk-gating"
            label={t("config.riskGating")}
            description={t("config.riskGatingHint")}
          >
            <Switch
              id="goal-config-risk-gating"
              checked={draft.riskGating ?? true}
              disabled={disabled}
              onCheckedChange={(checked) => setDraft({ ...draft, riskGating: checked })}
              aria-label={t("config.riskGating")}
              data-testid="goal-config-risk-gating"
            />
          </SettingsField>
        </SettingsBlock>
      </SettingsStack>

      {!disabled ? (
        // Sticks to the bottom of the inspector's scroll region, so Save stays
        // in reach without scrolling past twelve fields to find it.
        <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t bg-background/95 px-4 py-2 backdrop-blur">
          {dirty ? (
            <span className="mr-auto text-xs text-muted-foreground">{t("config.unsaved")}</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => setDraft(goal.config)}
            data-testid="goal-config-discard"
          >
            {t("config.discard")}
          </Button>
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={handleSave}
            data-testid="goal-config-save"
          >
            {saving ? t("config.saving") : t("config.save")}
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirmDisableVerification} onOpenChange={setConfirmDisableVerification}>
        <AlertDialogContent data-testid="goal-verification-disable-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("config.verification.disableTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("config.verification.disableConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("history.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDisableVerification(false)
                void persist()
              }}
              data-testid="goal-verification-disable-confirm"
            >
              {t("config.verification.disable")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
