"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  SettingsBlock,
  SettingsField,
  SettingsStack,
} from "@/components/settings/common/settings-block"
import { toast } from "sonner"
import { useSettingsStore } from "@/stores/settings"
import { resolveUserTimeZone } from "@/lib/profile/timezone"
import type { GoalDefaults, GoalQuietHours } from "@/types/goal"
import { DEFAULT_GOAL_CONFIG } from "@/lib/goal/runtime"
import { JudgeModelPicker } from "./judge-model-picker"

/**
 * Edit `AppSettings.goals` — the per-user defaults that apply to every new
 * goal (overridable per-goal from the detail sheet). Covers the budget knobs
 * plus the ADR-0019 Phase 2 judge-customization and pacing controls.
 *
 * Laid out as label ↔ control rows on the card-free settings primitives, with
 * number inputs at a bounded width: each one used to stretch the full width of
 * the console (1,300px for a two-digit turn count) and every switch sat in a
 * bordered box of its own. Save and Reset stick to the bottom of the scroll
 * region.
 */
export function GoalDefaultsForm() {
  const t = useTranslations("goal")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const stored = (settings as { goals?: GoalDefaults } | null | undefined)?.goals
  // New goals inherit the user's profile timezone (falls back to the device
  // zone). Previously read a never-set `settings.timezone`, so it always fell
  // through to the device zone.
  const appTimezone = resolveUserTimeZone(settings?.profile)
  const [draft, setDraft] = useState<GoalDefaults>(stored ?? {})
  // React's "storing information from previous renders" pattern: reset the
  // draft when the persisted defaults change externally (e.g. backup restore).
  const [boundStored, setBoundStored] = useState(stored)
  if (boundStored !== stored) {
    setBoundStored(stored)
    setDraft(stored ?? {})
  }
  const [saving, setSaving] = useState(false)

  const maxTurns = draft.maxTurns ?? DEFAULT_GOAL_CONFIG.maxTurns
  const maxTokens = draft.maxTokens ?? DEFAULT_GOAL_CONFIG.maxTokens
  const maxBudgetUsd = draft.maxBudgetUsd ?? 0
  const maxJudgeFailures = draft.maxJudgeFailures ?? DEFAULT_GOAL_CONFIG.maxJudgeFailures
  const timeoutMs = draft.timeoutMs ?? DEFAULT_GOAL_CONFIG.timeoutMs
  const startPaused = draft.startPaused ?? false
  const manualContinue = draft.manualContinue ?? false
  const adaptivePacing = draft.adaptivePacing ?? false
  const maxPromiseDenials = draft.maxPromiseDenials ?? 3
  const intervalSeconds = Math.round((draft.continuationIntervalMs ?? 0) / 1000)
  const quietHours = draft.quietHours
  const quietOn = Boolean(quietHours)

  /** Normalize a draft into the persisted shape, dropping empty optionals. */
  function normalize(d: GoalDefaults): GoalDefaults {
    const out: GoalDefaults = {
      maxTurns: d.maxTurns ?? DEFAULT_GOAL_CONFIG.maxTurns,
      maxTokens: d.maxTokens ?? DEFAULT_GOAL_CONFIG.maxTokens,
      maxJudgeFailures: d.maxJudgeFailures ?? DEFAULT_GOAL_CONFIG.maxJudgeFailures,
      timeoutMs: d.timeoutMs ?? DEFAULT_GOAL_CONFIG.timeoutMs,
      startPaused: d.startPaused ?? false,
    }
    if (typeof d.maxBudgetUsd === "number" && d.maxBudgetUsd > 0) out.maxBudgetUsd = d.maxBudgetUsd
    if (d.judgeModel?.trim()) out.judgeModel = d.judgeModel.trim()
    if (d.judgeProvider?.trim()) out.judgeProvider = d.judgeProvider.trim()
    if (typeof d.judgeTemperature === "number") out.judgeTemperature = d.judgeTemperature
    if (typeof d.judgeMaxTokens === "number" && d.judgeMaxTokens > 0)
      out.judgeMaxTokens = d.judgeMaxTokens
    if (d.judgePromptOverride?.trim()) out.judgePromptOverride = d.judgePromptOverride.trim()
    if (d.manualContinue) out.manualContinue = true
    if (d.adaptivePacing) out.adaptivePacing = true
    if (typeof d.maxPromiseDenials === "number" && d.maxPromiseDenials > 0)
      out.maxPromiseDenials = d.maxPromiseDenials
    if (d.continuationIntervalMs && d.continuationIntervalMs > 0)
      out.continuationIntervalMs = d.continuationIntervalMs
    if (d.quietHours?.from && d.quietHours.to) out.quietHours = d.quietHours
    return out
  }

  const dirty = JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(stored ?? {}))

  async function handleSave() {
    if (!dirty) return
    setSaving(true)
    try {
      await save({ goals: normalize(draft) } as Parameters<typeof save>[0])
      toast.success(t("defaults.saved"))
    } catch (error) {
      toast.error(t("config.saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSaving(false)
    }
  }

  /**
   * Stage the hard defaults: an empty draft renders `DEFAULT_GOAL_CONFIG`
   * values via the `?? default` fallbacks and drops every optional override.
   * The user still confirms with Save (no accidental wipe).
   */
  function handleReset() {
    setDraft({})
  }

  function patchQuietHours(patch: Partial<GoalQuietHours>) {
    const base: GoalQuietHours = quietHours ?? { from: "22:00", to: "07:00", tz: appTimezone }
    setDraft({ ...draft, quietHours: { ...base, ...patch } })
  }

  return (
    <div className="space-y-5 text-sm" data-testid="goal-defaults-form">
      <SettingsStack>
        <SettingsBlock title={t("defaults.budgetHeading")} headingLevel={3}>
          <Numeric
            id="goal-defaults-max-turns"
            label={t("defaults.maxTurns")}
            value={maxTurns}
            onChange={(n) => setDraft({ ...draft, maxTurns: n })}
            hint={t("defaults.maxTurnsHint")}
            testId="goal-defaults-max-turns"
          />
          <Numeric
            id="goal-defaults-max-tokens"
            label={t("defaults.maxTokens")}
            value={maxTokens}
            onChange={(n) => setDraft({ ...draft, maxTokens: n })}
            hint={t("defaults.maxTokensHint")}
            testId="goal-defaults-max-tokens"
          />
          <Numeric
            id="goal-defaults-max-budget-usd"
            label={t("defaults.maxBudgetUsd")}
            value={maxBudgetUsd}
            onChange={(n) => setDraft({ ...draft, maxBudgetUsd: Math.max(0, n) })}
            hint={t("defaults.maxBudgetUsdHint")}
            step={0.5}
            testId="goal-defaults-max-budget-usd"
          />
          <Numeric
            id="goal-defaults-max-judge-failures"
            label={t("defaults.maxJudgeFailures")}
            value={maxJudgeFailures}
            onChange={(n) => setDraft({ ...draft, maxJudgeFailures: n })}
            hint={t("defaults.maxJudgeFailuresHint")}
            testId="goal-defaults-max-judge-failures"
          />
          <Numeric
            id="goal-defaults-timeout"
            label={t("defaults.timeout")}
            value={Math.round(timeoutMs / 60_000)}
            onChange={(n) => setDraft({ ...draft, timeoutMs: n * 60_000 })}
            hint={t("defaults.timeoutHint")}
            testId="goal-defaults-timeout"
          />
          <ToggleRow
            id="goal-defaults-start-paused"
            label={t("defaults.startPaused")}
            hint={t("defaults.startPausedHint")}
            checked={startPaused}
            onChange={(checked) => setDraft({ ...draft, startPaused: checked })}
            testId="goal-defaults-start-paused"
          />
        </SettingsBlock>

        <SettingsBlock title={t("judge.heading")} headingLevel={3}>
          <SettingsField label={t("judge.model")} description={t("judge.modelHint")} stacked>
            <JudgeModelPicker
              model={draft.judgeModel}
              provider={draft.judgeProvider}
              onChange={({ model, provider }) =>
                setDraft({ ...draft, judgeModel: model, judgeProvider: provider })
              }
            />
          </SettingsField>
          <Numeric
            id="goal-defaults-judge-temperature"
            label={t("judge.temperature")}
            value={draft.judgeTemperature ?? 0}
            onChange={(n) => setDraft({ ...draft, judgeTemperature: n })}
            hint={t("judge.temperatureHint")}
            step={0.1}
            testId="goal-defaults-judge-temperature"
          />
          <Numeric
            id="goal-defaults-judge-max-tokens"
            label={t("judge.maxTokens")}
            value={draft.judgeMaxTokens ?? 200}
            onChange={(n) => setDraft({ ...draft, judgeMaxTokens: n })}
            hint={t("judge.maxTokensHint")}
            testId="goal-defaults-judge-max-tokens"
          />
          <SettingsField
            htmlFor="goal-defaults-judge-prompt"
            label={t("judge.promptOverride")}
            description={t("judge.promptOverrideHint")}
            stacked
          >
            <Textarea
              id="goal-defaults-judge-prompt"
              value={draft.judgePromptOverride ?? ""}
              rows={3}
              onChange={(e) => setDraft({ ...draft, judgePromptOverride: e.target.value })}
              data-testid="goal-defaults-judge-prompt"
            />
          </SettingsField>
        </SettingsBlock>

        <SettingsBlock title={t("pacing.heading")} headingLevel={3}>
          <ToggleRow
            id="goal-defaults-manual-continue"
            label={t("pacing.manualContinue")}
            hint={t("pacing.manualContinueHint")}
            checked={manualContinue}
            onChange={(checked) => setDraft({ ...draft, manualContinue: checked })}
            testId="goal-defaults-manual-continue"
          />
          <Numeric
            id="goal-defaults-interval"
            label={t("pacing.interval")}
            value={intervalSeconds}
            onChange={(n) => setDraft({ ...draft, continuationIntervalMs: Math.max(0, n) * 1000 })}
            hint={t("pacing.intervalHint")}
            testId="goal-defaults-interval"
          />
          <ToggleRow
            id="goal-defaults-adaptive-pacing"
            label={t("pacing.adaptivePacing")}
            hint={t("pacing.adaptivePacingHint")}
            checked={adaptivePacing}
            onChange={(checked) => setDraft({ ...draft, adaptivePacing: checked })}
            testId="goal-defaults-adaptive-pacing"
          />
          <ToggleRow
            id="goal-defaults-quiet-hours"
            label={t("pacing.quietHoursEnable")}
            hint={t("pacing.quietHoursHint")}
            checked={quietOn}
            onChange={(checked) =>
              setDraft({
                ...draft,
                quietHours: checked ? { from: "22:00", to: "07:00", tz: appTimezone } : undefined,
              })
            }
            testId="goal-defaults-quiet-hours"
          />
          {quietOn ? (
            <div className="flex flex-wrap gap-3 pl-0.5">
              <div className="space-y-1">
                <Label htmlFor="goal-defaults-quiet-from" className="text-xs text-muted-foreground">
                  {t("pacing.quietHoursFrom")}
                </Label>
                <Input
                  id="goal-defaults-quiet-from"
                  type="time"
                  className="w-32"
                  value={quietHours?.from ?? "22:00"}
                  onChange={(e) => patchQuietHours({ from: e.target.value })}
                  data-testid="goal-defaults-quiet-from"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="goal-defaults-quiet-to" className="text-xs text-muted-foreground">
                  {t("pacing.quietHoursTo")}
                </Label>
                <Input
                  id="goal-defaults-quiet-to"
                  type="time"
                  className="w-32"
                  value={quietHours?.to ?? "07:00"}
                  onChange={(e) => patchQuietHours({ to: e.target.value })}
                  data-testid="goal-defaults-quiet-to"
                />
              </div>
            </div>
          ) : null}
        </SettingsBlock>

        <SettingsBlock title={t("defaults.completionHeading")} headingLevel={3}>
          <Numeric
            id="goal-defaults-max-promise-denials"
            label={t("defaults.maxPromiseDenials")}
            value={maxPromiseDenials}
            onChange={(n) => setDraft({ ...draft, maxPromiseDenials: Math.max(1, n) })}
            hint={t("defaults.maxPromiseDenialsHint")}
            testId="goal-defaults-max-promise-denials"
          />
        </SettingsBlock>
      </SettingsStack>

      <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t bg-background/95 py-3 backdrop-blur">
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={handleReset}
          data-testid="goal-defaults-reset"
        >
          {t("defaults.reset")}
        </Button>
        <div className="flex items-center gap-3">
          {dirty ? (
            <span className="text-xs text-muted-foreground">{t("config.unsaved")}</span>
          ) : null}
          <Button
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
            data-testid="goal-defaults-save"
          >
            {saving ? t("defaults.saving") : t("defaults.save")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Numeric({
  id,
  label,
  hint,
  value,
  onChange,
  testId,
  step,
}: {
  id: string
  label: string
  hint?: string
  value: number
  onChange: (next: number) => void
  testId?: string
  step?: number
}) {
  return (
    <SettingsField htmlFor={id} label={label} description={hint}>
      <Input
        id={id}
        type="number"
        step={step}
        className="w-32 tabular-nums"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || value)}
        data-testid={testId}
      />
    </SettingsField>
  )
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  id: string
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
  testId?: string
}) {
  return (
    <SettingsField htmlFor={id} label={label} description={hint}>
      <Switch id={id} checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </SettingsField>
  )
}
