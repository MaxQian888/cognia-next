"use client"

/**
 * The editable preview of a conversation summary draft
 * (`useConversationSummaryDraft`): a label, a regenerate button, the text and,
 * when no model summary was possible, why the draft is only a digest.
 */

import { useId } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { SummaryFallbackReason } from "@/hooks/chat/use-conversation-summary-draft"

/** Message key per reason (next-intl keys stay camelCase). */
const SUMMARY_FALLBACK_KEYS = {
  empty: "summary.fallback.empty",
  "no-client": "summary.fallback.noClient",
  "no-output": "summary.fallback.noOutput",
  pii: "summary.fallback.pii",
} as const satisfies Record<SummaryFallbackReason, string>

export interface ConversationSummaryEditorProps {
  label: string
  text: string
  onTextChange: (text: string) => void
  generating: boolean
  fallback: SummaryFallbackReason | null
  onRegenerate: () => void
  /** The button's label; defaults to "Regenerate". */
  regenerateLabel?: string
  rows?: number
}

export function ConversationSummaryEditor({
  label,
  text,
  onTextChange,
  generating,
  fallback,
  onRegenerate,
  regenerateLabel,
  rows = 6,
}: ConversationSummaryEditorProps) {
  const t = useTranslations("chat.branch")
  const textareaId = useId()
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label htmlFor={textareaId} className="text-xs">
          {label}
        </Label>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={onRegenerate}
          disabled={generating}
        >
          {generating && <Loader2Icon className="mr-1 size-3 animate-spin" />}
          {regenerateLabel ?? t("summary.regenerate")}
        </Button>
      </div>
      <Textarea
        id={textareaId}
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        rows={rows}
        placeholder={generating ? t("summary.generating") : t("summary.placeholder")}
        disabled={generating}
      />
      {fallback && !generating ? (
        <p
          className="text-xs text-amber-700 dark:text-amber-400"
          role="status"
          data-testid="branch-summary-fallback"
        >
          {t(SUMMARY_FALLBACK_KEYS[fallback])}
        </p>
      ) : null}
    </div>
  )
}
