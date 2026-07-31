"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import { resolveUserTimeZone } from "@/lib/profile/timezone"
import type { GoalDefaults, GoalQuietHours } from "@/types/goal"
import { DEFAULT_GOAL_CONFIG } from "@/lib/goal/runtime"
import { JudgeModelPicker } from "./judge-model-picker"

/**
 * Edit `AppSettings.goals` — the per-user defaults that apply to every new
 * goal (overridable per-goal from the detail sheet). Covers the budget knobs
 * plus the ADR-0019 Phase 2 judge-customization and pacing controls.
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
    <div className="space-y-3 text-sm" data-testid="goal-defaults-form">
      {/* ── Budget & limits ─────────────────────────────────────────────── */}
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("defaults.budgetHeading")}
      </h3>
      <Numeric
        label={t("defaults.maxTurns")}
        value={maxTurns}
        onChange={(n) => setDraft({ ...draft, maxTurns: n })}
        hint={t("defaults.maxTurnsHint")}
        testId="goal-defaults-max-turns"
      />
      <Numeric
        label={t("defaults.maxTokens")}
        value={maxTokens}
        onChange={(n) => setDraft({ ...draft, maxTokens: n })}
        hint={t("defaults.maxTokensHint")}
        testId="goal-defaults-max-tokens"
      />
      <Numeric
        label={t("defaults.maxBudgetUsd")}
        value={maxBudgetUsd}
        onChange={(n) => setDraft({ ...draft, maxBudgetUsd: Math.max(0, n) })}
        hint={t("defaults.maxBudgetUsdHint")}
        step={0.5}
        testId="goal-defaults-max-budget-usd"
      />
      <Numeric
        label={t("defaults.maxJudgeFailures")}
        value={maxJudgeFailures}
        onChange={(n) => setDraft({ ...draft, maxJudgeFailures: n })}
        hint={t("defaults.maxJudgeFailuresHint")}
        testId="goal-defaults-max-judge-failures"
      />
      <Numeric
        label={t("defaults.timeout")}
        value={Math.round(timeoutMs / 60_000)}
        onChange={(n) => setDraft({ ...draft, timeoutMs: n * 60_000 })}
        hint={t("defaults.timeoutHint")}
        testId="goal-defaults-timeout"
      />
      <ToggleRow
        label={t("defaults.startPaused")}
        hint={t("defaults.startPausedHint")}
        checked={startPaused}
        onChange={(checked) => setDraft({ ...draft, startPaused: checked })}
        testId="goal-defaults-start-paused"
      />

      {/* ── Judge ───────────────────────────────────────────────────────── */}
      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("judge.heading")}
      </h3>
      <div>
        <Label className="text-xs font-medium">{t("judge.model")}</Label>
        <JudgeModelPicker
          model={draft.judgeModel}
          provider={draft.judgeProvider}
          onChange={({ model, provider }) =>
            setDraft({ ...draft, judgeModel: model, judgeProvider: provider })
          }
        />
        <p className="mt-1 text-[10px] text-muted-foreground">{t("judge.modelHint")}</p>
      </div>
      <Numeric
        label={t("judge.temperature")}
        value={draft.judgeTemperature ?? 0}
        onChange={(n) => setDraft({ ...draft, judgeTemperature: n })}
        hint={t("judge.temperatureHint")}
        step={0.1}
        testId="goal-defaults-judge-temperature"
      />
      <Numeric
        label={t("judge.maxTokens")}
        value={draft.judgeMaxTokens ?? 200}
        onChange={(n) => setDraft({ ...draft, judgeMaxTokens: n })}
        hint={t("judge.maxTokensHint")}
        testId="goal-defaults-judge-max-tokens"
      />
      <div>
        <Label className="text-xs font-medium">{t("judge.promptOverride")}</Label>
        <Textarea
          value={draft.judgePromptOverride ?? ""}
          rows={3}
          onChange={(e) => setDraft({ ...draft, judgePromptOverride: e.target.value })}
          data-testid="goal-defaults-judge-prompt"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">{t("judge.promptOverrideHint")}</p>
      </div>

      {/* ── Pacing ──────────────────────────────────────────────────────── */}
      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pacing.heading")}
      </h3>
      <ToggleRow
        label={t("pacing.manualContinue")}
        hint={t("pacing.manualContinueHint")}
        checked={manualContinue}
        onChange={(checked) => setDraft({ ...draft, manualContinue: checked })}
        testId="goal-defaults-manual-continue"
      />
      <Numeric
        label={t("pacing.interval")}
        value={intervalSeconds}
        onChange={(n) => setDraft({ ...draft, continuationIntervalMs: Math.max(0, n) * 1000 })}
        hint={t("pacing.intervalHint")}
        testId="goal-defaults-interval"
      />
      <ToggleRow
        label={t("pacing.adaptivePacing")}
        hint={t("pacing.adaptivePacingHint")}
        checked={adaptivePacing}
        onChange={(checked) => setDraft({ ...draft, adaptivePacing: checked })}
        testId="goal-defaults-adaptive-pacing"
      />
      <div className="rounded-md border p-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{t("pacing.quietHoursEnable")}</Label>
            <p className="text-xs text-muted-foreground">{t("pacing.quietHoursHint")}</p>
          </div>
          <Switch
            checked={quietOn}
            onCheckedChange={(checked) =>
              setDraft({
                ...draft,
                quietHours: checked ? { from: "22:00", to: "07:00", tz: appTimezone } : undefined,
              })
            }
            data-testid="goal-defaults-quiet-hours"
          />
        </div>
        {quietOn && (
          <div className="mt-3 flex gap-3">
            <div className="flex-1">
              <Label className="text-[10px] text-muted-foreground">
                {t("pacing.quietHoursFrom")}
              </Label>
              <Input
                type="time"
                value={quietHours?.from ?? "22:00"}
                onChange={(e) => patchQuietHours({ from: e.target.value })}
                data-testid="goal-defaults-quiet-from"
              />
            </div>
            <div className="flex-1">
              <Label className="text-[10px] text-muted-foreground">
                {t("pacing.quietHoursTo")}
              </Label>
              <Input
                type="time"
                value={quietHours?.to ?? "07:00"}
                onChange={(e) => patchQuietHours({ to: e.target.value })}
                data-testid="goal-defaults-quiet-to"
              />
            </div>
          </div>
        )}
      </div>

      {/* ── Completion gate ─────────────────────────────────────────────── */}
      <h3 className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("defaults.completionHeading")}
      </h3>
      <Numeric
        label={t("defaults.maxPromiseDenials")}
        value={maxPromiseDenials}
        onChange={(n) => setDraft({ ...draft, maxPromiseDenials: Math.max(1, n) })}
        hint={t("defaults.maxPromiseDenialsHint")}
        testId="goal-defaults-max-promise-denials"
      />

      <div className="flex items-center justify-between pt-2">
        <Button
          variant="ghost"
          disabled={saving}
          onClick={handleReset}
          data-testid="goal-defaults-reset"
        >
          {t("defaults.reset")}
        </Button>
        <Button
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
          data-testid="goal-defaults-save"
        >
          {saving ? t("defaults.saving") : t("defaults.save")}
        </Button>
      </div>
    </div>
  )
}

function Numeric({
  label,
  hint,
  value,
  onChange,
  testId,
  step,
}: {
  label: string
  hint?: string
  value: number
  onChange: (next: number) => void
  testId?: string
  step?: number
}) {
  return (
    <div>
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || value)}
        data-testid={testId}
      />
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
  testId?: string
}) {
  return (
    <div className="flex items-center justify-between rounded-md border p-3">
      <div>
        <Label className="text-sm font-medium">{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} data-testid={testId} />
    </div>
  )
}
