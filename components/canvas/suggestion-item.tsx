"use client"

/**
 * SuggestionItem - Individual suggestion component with inline diff preview.
 *
 * Shows the model's self-reported confidence when Settings → Canvas → AI →
 * "Show confidence" is on. That switch shipped with nothing behind it: no
 * suggestion carried a confidence and no surface rendered one, so turning it on
 * changed nothing. The badge is omitted for a suggestion whose model gave no
 * usable number rather than inventing one.
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, X, ChevronDown, Bug, Sparkles, MessageSquare, Edit3 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { SUGGESTION_TYPE_COLORS } from "@/lib/canvas/constants"
import type { CanvasSuggestion } from "@/types"

interface SuggestionItemProps {
  suggestion: CanvasSuggestion
  onApply: (id: string) => void
  onReject: (id: string) => void
  className?: string
}

const TYPE_ICONS = {
  fix: Bug,
  improve: Sparkles,
  comment: MessageSquare,
  edit: Edit3,
}

export const SuggestionItem = memo(function SuggestionItem({
  suggestion,
  onApply,
  onReject,
  className,
}: SuggestionItemProps) {
  const t = useTranslations("canvas")
  const [open, setOpen] = useState(false)
  const showConfidence = useCanvasSettingsStore((s) => s.settings.ai.showConfidence)

  const Icon = TYPE_ICONS[suggestion.type] || Edit3
  const colorClass = SUGGESTION_TYPE_COLORS[suggestion.type] || SUGGESTION_TYPE_COLORS.edit

  const hasCodeDiff = suggestion.originalText && suggestion.suggestedText

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 space-y-2 transition-all",
        suggestion.status === "accepted" && "opacity-50",
        suggestion.status === "rejected" && "opacity-30 line-through",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className={cn("p-1.5 rounded-md shrink-0", colorClass)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="text-[10px]">
              {suggestion.type}
            </Badge>
            {suggestion.range && (
              <span className="text-[10px] text-muted-foreground">
                {t("lines")} {suggestion.range.startLine}
                {suggestion.range.endLine !== suggestion.range.startLine &&
                  `-${suggestion.range.endLine}`}
              </span>
            )}
            {showConfidence && suggestion.confidence !== undefined && (
              <Badge
                variant="secondary"
                className="text-[10px]"
                data-testid="suggestion-confidence"
                title={t("confidenceHint")}
              >
                {t("confidence", { percent: Math.round(suggestion.confidence * 100) })}
              </Badge>
            )}
          </div>
          <p className="text-sm leading-relaxed">{suggestion.explanation}</p>
        </div>
      </div>

      {/* Code diff preview */}
      {hasCodeDiff && (
        <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs w-full justify-between">
              <span>{t("viewChanges")}</span>
              <ChevronDown className="h-3 w-3 transition-transform data-[state=open]:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="rounded-md border bg-muted/30 p-2 space-y-2 text-xs sm:text-sm font-mono">
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground font-sans">{t("original")}:</div>
              <pre className="p-2 rounded bg-destructive/10 text-destructive whitespace-pre-wrap overflow-x-auto">
                {suggestion.originalText}
              </pre>
            </div>
            <div className="space-y-1">
              <div className="text-[10px] text-muted-foreground font-sans">{t("suggested")}:</div>
              <pre className="p-2 rounded bg-success/10 text-success whitespace-pre-wrap overflow-x-auto">
                {suggestion.suggestedText}
              </pre>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Actions */}
      {suggestion.status === "pending" && (
        <div className="flex items-center gap-2 pt-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" className="h-9 flex-1" onClick={() => onApply(suggestion.id)}>
                <Check className="h-3.5 w-3.5 mr-1" />
                {t("apply")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("apply")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 flex-1"
                onClick={() => onReject(suggestion.id)}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t("dismiss")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("dismiss")}</TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Status badge for applied/rejected */}
      {suggestion.status !== "pending" && (
        <div className="flex justify-center">
          <Badge
            variant={suggestion.status === "accepted" ? "default" : "secondary"}
            className="text-[10px]"
          >
            {suggestion.status === "accepted" ? t("applied") : t("dismissed")}
          </Badge>
        </div>
      )}
    </div>
  )
})
