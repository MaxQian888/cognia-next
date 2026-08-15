"use client"

/**
 * Structured payload editor for `im-push` tasks — push a text (or raw
 * segments) into an already-bound IM conversation on a schedule (executor:
 * `lib/scheduler/executors/im-push-executor.ts`).
 *
 * The conversation must (a) have a persisted delivery target — the bot has
 * exchanged at least one message with it — and (b) have proactive push
 * enabled in its conversation settings; both are enforced fail-closed by the
 * executor and explained here so the task is not authored blind.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { ImPushDraft } from "./types"

export interface ImPushPayloadEditorProps {
  draft: ImPushDraft
  onDraftChange: (next: ImPushDraft) => void
  errors?: Record<string, string>
  disabled?: boolean
  testId?: string
}

export function ImPushPayloadEditor({
  draft,
  onDraftChange,
  errors,
  disabled,
  testId = "im-push-payload-editor",
}: ImPushPayloadEditorProps) {
  const t = useTranslations("scheduler")

  function update<K extends keyof ImPushDraft>(key: K, value: ImPushDraft[K]) {
    onDraftChange({ ...draft, [key]: value })
  }

  const usingSegments = draft.segmentsJson.trim().length > 0

  return (
    <div className="space-y-4" data-testid={testId}>
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.imPush.conversationKey")} <span className="text-destructive">*</span>
        </Label>
        <Input
          value={draft.conversationKey}
          onChange={(e) => update("conversationKey", e.target.value)}
          placeholder={t("payload.imPush.conversationKeyPlaceholder")}
          disabled={disabled}
          className={cn(
            "h-10 font-mono text-xs",
            errors?.conversationKey && "border-destructive focus-visible:ring-destructive/20"
          )}
          data-testid={`${testId}-conversation-input`}
        />
        {errors?.conversationKey && (
          <p className="text-xs text-destructive">
            {t(`payload.errors.${errors.conversationKey}`)}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("payload.imPush.conversationKeyHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">
          {t("payload.imPush.text")}
          {!usingSegments && <span className="text-destructive"> *</span>}
        </Label>
        <Textarea
          value={draft.text}
          onChange={(e) => update("text", e.target.value)}
          rows={4}
          placeholder={t("payload.imPush.textPlaceholder")}
          disabled={disabled || usingSegments}
          className={cn(errors?.text && "border-destructive focus-visible:ring-destructive/20")}
          data-testid={`${testId}-text-input`}
        />
        {errors?.text && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.text}`)}</p>
        )}
        {usingSegments && (
          <p className="text-xs text-muted-foreground">{t("payload.imPush.textIgnoredHint")}</p>
        )}
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.imPush.segments")}</Label>
        <Textarea
          value={draft.segmentsJson}
          onChange={(e) => update("segmentsJson", e.target.value)}
          rows={4}
          placeholder={'[\n  { "type": "text", "text": "…" }\n]'}
          disabled={disabled}
          className={cn(
            "font-mono text-xs",
            errors?.segmentsJson && "border-destructive focus-visible:ring-destructive/20"
          )}
          data-testid={`${testId}-segments-input`}
        />
        {errors?.segmentsJson && (
          <p className="text-xs text-destructive">{t(`payload.errors.${errors.segmentsJson}`)}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("payload.imPush.segmentsHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">{t("payload.imPush.idempotencyKey")}</Label>
        <Input
          value={draft.idempotencyKey}
          onChange={(e) => update("idempotencyKey", e.target.value)}
          placeholder={t("payload.imPush.idempotencyKeyPlaceholder")}
          disabled={disabled}
          className="h-10 font-mono text-xs"
          data-testid={`${testId}-idempotency-input`}
        />
      </div>

      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        {t("payload.imPush.guardrails")}
      </p>
    </div>
  )
}
