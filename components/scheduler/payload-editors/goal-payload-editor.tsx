"use client"

/**
 * Structured payload editor for `goal` tasks. Creates a self-driving `/goal`
 * (ADR-0019) in a background session and drives it to terminal headlessly.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { GoalDraft } from "./types"

export interface GoalPayloadEditorProps {
  draft: GoalDraft
  onDraftChange: (next: GoalDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
}

function toNum(value: string): number | undefined {
  const n = parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function GoalPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "goal-payload-editor",
}: GoalPayloadEditorProps) {
  const t = useTranslations("scheduler")

  function update<K extends keyof GoalDraft>(key: K, value: GoalDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.goal.objective")} <span className="text-destructive">*</span>
        </Label>
        <Textarea
          value={draft.objective}
          onChange={(e) => update("objective", e.target.value)}
          rows={3}
          placeholder={t("payload.goal.objectivePlaceholder")}
          disabled={disabled}
          className={cn(
            errors?.objective && "border-destructive focus-visible:ring-destructive/20"
          )}
          data-testid={`${testId}-objective-input`}
        />
        {errors?.objective && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.objective}`)}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("payload.goal.objectiveHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.goal.characterId")}</Label>
        <Input
          value={draft.characterId ?? ""}
          onChange={(e) => update("characterId", e.target.value || undefined)}
          placeholder={t("payload.goal.characterIdPlaceholder")}
          disabled={disabled}
          className="h-10 font-mono text-xs"
          data-testid={`${testId}-character-input`}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.goal.maxTurns")}</Label>
          <Input
            type="number"
            min={1}
            value={draft.maxTurns ?? ""}
            onChange={(e) => update("maxTurns", toNum(e.target.value))}
            placeholder={t("payload.goal.defaultHint")}
            disabled={disabled}
            className="h-10"
            data-testid={`${testId}-max-turns-input`}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.goal.maxTokens")}</Label>
          <Input
            type="number"
            min={1}
            value={draft.maxTokens ?? ""}
            onChange={(e) => update("maxTokens", toNum(e.target.value))}
            placeholder={t("payload.goal.defaultHint")}
            disabled={disabled}
            className="h-10"
            data-testid={`${testId}-max-tokens-input`}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-sm font-medium">{t("payload.goal.timeoutMinutes")}</Label>
          <Input
            type="number"
            min={1}
            value={draft.timeoutMinutes ?? ""}
            onChange={(e) => update("timeoutMinutes", toNum(e.target.value))}
            placeholder={t("payload.goal.defaultHint")}
            disabled={disabled}
            className="h-10"
            data-testid={`${testId}-timeout-input`}
          />
        </div>
      </div>
    </div>
  )
}
