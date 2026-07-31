"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import type { Loop, LoopConfig } from "@/types/loop"
import { getLoopRuntime } from "@/lib/loop/runtime"
import { isTerminalLoopStatus } from "@/types/loop"

interface Props {
  loop: Loop
}

/**
 * Per-loop config editor — caps + self-paced delay bounds. Mirrors the
 * goal settings tab, including the "storing information from previous
 * renders" draft-reset pattern. Disabled for terminal loops.
 */
export function LoopSettingsTab({ loop }: Props) {
  const t = useTranslations("loop")
  const disabled = isTerminalLoopStatus(loop.status)
  const [draft, setDraft] = useState<LoopConfig>(loop.config)
  const [boundLoopId, setBoundLoopId] = useState(loop.id)
  if (boundLoopId !== loop.id) {
    setBoundLoopId(loop.id)
    setDraft(loop.config)
  }
  const [saving, setSaving] = useState(false)

  const dirty =
    draft.maxIterations !== loop.config.maxIterations ||
    draft.maxTokens !== loop.config.maxTokens ||
    draft.minDelayMs !== loop.config.minDelayMs ||
    draft.maxDelayMs !== loop.config.maxDelayMs ||
    draft.maxParseFailures !== loop.config.maxParseFailures

  async function handleSave() {
    if (!dirty || disabled) return
    setSaving(true)
    try {
      await getLoopRuntime().updateConfig(loop.id, {
        maxIterations: Math.max(1, draft.maxIterations),
        maxTokens: Math.max(1000, draft.maxTokens),
        minDelayMs: Math.max(60_000, draft.minDelayMs),
        maxDelayMs: Math.max(Math.max(60_000, draft.minDelayMs), draft.maxDelayMs),
        maxParseFailures: Math.max(1, draft.maxParseFailures),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 text-sm" data-testid="loop-settings-form">
      <Field label={t("config.maxIterations")} hint={t("config.maxIterationsHint")}>
        <Input
          type="number"
          min={1}
          value={draft.maxIterations}
          disabled={disabled}
          onChange={(e) =>
            setDraft({ ...draft, maxIterations: Number(e.target.value) || draft.maxIterations })
          }
          data-testid="loop-config-max-iterations"
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
          data-testid="loop-config-max-tokens"
        />
      </Field>
      {loop.mode === "self_paced" && (
        <>
          <Field label={t("config.minDelay")} hint={t("config.minDelayHint")}>
            <Input
              type="number"
              min={1}
              value={Math.round(draft.minDelayMs / 60_000)}
              disabled={disabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  minDelayMs:
                    (Number(e.target.value) || Math.round(draft.minDelayMs / 60_000)) * 60_000,
                })
              }
              data-testid="loop-config-min-delay"
            />
          </Field>
          <Field label={t("config.maxDelay")} hint={t("config.maxDelayHint")}>
            <Input
              type="number"
              min={1}
              value={Math.round(draft.maxDelayMs / 60_000)}
              disabled={disabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxDelayMs:
                    (Number(e.target.value) || Math.round(draft.maxDelayMs / 60_000)) * 60_000,
                })
              }
              data-testid="loop-config-max-delay"
            />
          </Field>
          <Field label={t("config.maxParseFailures")} hint={t("config.maxParseFailuresHint")}>
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.maxParseFailures}
              disabled={disabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  maxParseFailures: Number(e.target.value) || draft.maxParseFailures,
                })
              }
              data-testid="loop-config-max-parse-failures"
            />
          </Field>
        </>
      )}
      <div className="flex justify-end pt-2">
        <Button
          disabled={!dirty || disabled || saving}
          onClick={() => void handleSave()}
          data-testid="loop-config-save"
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
