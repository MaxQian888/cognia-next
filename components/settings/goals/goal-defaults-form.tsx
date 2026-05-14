"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useSettingsStore } from "@/stores/settings"
import type { GoalDefaults } from "@/types/goal"
import { DEFAULT_GOAL_CONFIG } from "@/lib/goal/runtime"

/**
 * Edit `AppSettings.goals` — the per-user defaults that apply to every
 * new goal. These can still be overridden on a per-goal basis from the
 * Sheet's Settings tab.
 */
export function GoalDefaultsForm() {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const stored = (settings as { goals?: GoalDefaults } | null | undefined)?.goals
  const [draft, setDraft] = useState<GoalDefaults>(stored ?? {})
  // React's "storing information from previous renders" pattern. Resets the
  // draft when the persisted defaults change externally (e.g. backup restore).
  // Compare by identity — the settings store rebuilds the goals subobject on
  // every save.
  const [boundStored, setBoundStored] = useState(stored)
  if (boundStored !== stored) {
    setBoundStored(stored)
    setDraft(stored ?? {})
  }
  const [saving, setSaving] = useState(false)

  const maxTurns = draft.maxTurns ?? DEFAULT_GOAL_CONFIG.maxTurns
  const maxTokens = draft.maxTokens ?? DEFAULT_GOAL_CONFIG.maxTokens
  const maxJudgeFailures = draft.maxJudgeFailures ?? DEFAULT_GOAL_CONFIG.maxJudgeFailures
  const timeoutMs = draft.timeoutMs ?? DEFAULT_GOAL_CONFIG.timeoutMs
  const startPaused = draft.startPaused ?? false

  const dirty =
    JSON.stringify({
      maxTurns,
      maxTokens,
      maxJudgeFailures,
      timeoutMs,
      startPaused,
    }) !==
    JSON.stringify({
      maxTurns: stored?.maxTurns ?? DEFAULT_GOAL_CONFIG.maxTurns,
      maxTokens: stored?.maxTokens ?? DEFAULT_GOAL_CONFIG.maxTokens,
      maxJudgeFailures: stored?.maxJudgeFailures ?? DEFAULT_GOAL_CONFIG.maxJudgeFailures,
      timeoutMs: stored?.timeoutMs ?? DEFAULT_GOAL_CONFIG.timeoutMs,
      startPaused: stored?.startPaused ?? false,
    })

  async function handleSave() {
    if (!dirty) return
    setSaving(true)
    try {
      await save({
        goals: {
          maxTurns,
          maxTokens,
          maxJudgeFailures,
          timeoutMs,
          startPaused,
        },
      } as Parameters<typeof save>[0])
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 text-sm" data-testid="goal-defaults-form">
      <Numeric
        label="Default max turns"
        value={maxTurns}
        onChange={(n) => setDraft({ ...draft, maxTurns: n })}
        hint="Hard cap on continuation turns for a new goal."
        testId="goal-defaults-max-turns"
      />
      <Numeric
        label="Default max tokens"
        value={maxTokens}
        onChange={(n) => setDraft({ ...draft, maxTokens: n })}
        hint="Cumulative input + output tokens billed against the goal."
        testId="goal-defaults-max-tokens"
      />
      <Numeric
        label="Default max judge failures"
        value={maxJudgeFailures}
        onChange={(n) => setDraft({ ...draft, maxJudgeFailures: n })}
        hint="Consecutive JSON parse failures before auto-pause."
        testId="goal-defaults-max-judge-failures"
      />
      <Numeric
        label="Default timeout (minutes)"
        value={Math.round(timeoutMs / 60_000)}
        onChange={(n) => setDraft({ ...draft, timeoutMs: n * 60_000 })}
        hint="Wall-clock cap from goal creation."
        testId="goal-defaults-timeout"
      />
      <div className="flex items-center justify-between rounded-md border p-3">
        <div>
          <Label className="text-sm font-medium">Start new goals paused</Label>
          <p className="text-xs text-muted-foreground">
            When on, new goals require a `/goal resume` before the loop begins.
          </p>
        </div>
        <Switch
          checked={startPaused}
          onCheckedChange={(checked) => setDraft({ ...draft, startPaused: checked })}
          data-testid="goal-defaults-start-paused"
        />
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
          data-testid="goal-defaults-save"
        >
          {saving ? "Saving…" : "Save defaults"}
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
}: {
  label: string
  hint?: string
  value: number
  onChange: (next: number) => void
  testId?: string
}) {
  return (
    <div>
      <Label className="text-xs font-medium">{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value) || value)}
        data-testid={testId}
      />
      {hint && <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}
