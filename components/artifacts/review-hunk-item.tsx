"use client"

/**
 * ReviewHunkItem - one hunk of an AI-revision proposal, with accept/reject
 * controls and a collapsible inline diff preview. Modeled on the Canvas
 * `SuggestionItem` but driven by a `CanvasReviewItem` (per-hunk review).
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, X, ChevronDown, FilePlus2, FileMinus2, FileDiff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { CanvasReviewItem } from "@/types"

interface ReviewHunkItemProps {
  item: CanvasReviewItem
  onAccept: (id: string) => void
  onReject: (id: string) => void
  /** Disable the controls (e.g. while the proposal is stale). */
  disabled?: boolean
  className?: string
}

const CHANGE_ICONS = {
  insert: FilePlus2,
  delete: FileMinus2,
  replace: FileDiff,
} as const

const CHANGE_LABEL_KEYS = {
  insert: "hunkInsert",
  delete: "hunkDelete",
  replace: "hunkReplace",
} as const

export const ReviewHunkItem = memo(function ReviewHunkItem({
  item,
  onAccept,
  onReject,
  disabled,
  className,
}: ReviewHunkItemProps) {
  const t = useTranslations("artifacts.review")
  const [open, setOpen] = useState(false)

  const Icon = CHANGE_ICONS[item.changeType]
  const rangeLabel =
    item.range.endLine > item.range.startLine
      ? `${item.range.startLine}-${item.range.endLine}`
      : `${item.range.startLine}`

  return (
    <div
      data-testid="review-hunk-item"
      className={cn(
        "rounded-lg border bg-card p-3 space-y-2 transition-all",
        item.status === "accepted" && "border-green-500/40",
        item.status === "rejected" && "opacity-40",
        className
      )}
    >
      <div className="flex items-start gap-2">
        <div className="p-1.5 rounded-md shrink-0 bg-muted text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px]">
              {t(CHANGE_LABEL_KEYS[item.changeType])}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {t("lines")} {rangeLabel}
            </span>
          </div>
        </div>
      </div>

      <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs w-full justify-between">
            <span>{t("viewChanges")}</span>
            <ChevronDown className="h-3 w-3 transition-transform data-[state=open]:rotate-180" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="rounded-md border bg-muted/30 p-2 text-xs font-mono">
          <pre className="overflow-x-auto whitespace-pre-wrap">
            {item.diffLines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "px-1",
                  line.type === "added" && "bg-green-500/10 text-green-700 dark:text-green-300",
                  line.type === "removed" && "bg-red-500/10 text-red-700 dark:text-red-300"
                )}
              >
                <span className="select-none opacity-50">
                  {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                </span>{" "}
                {line.content}
              </div>
            ))}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant={item.status === "accepted" ? "default" : "outline"}
          className="h-8 flex-1"
          disabled={disabled}
          aria-pressed={item.status === "accepted"}
          onClick={() => onAccept(item.id)}
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          {t("accept")}
        </Button>
        <Button
          size="sm"
          variant={item.status === "rejected" ? "secondary" : "ghost"}
          className="h-8 flex-1"
          disabled={disabled}
          aria-pressed={item.status === "rejected"}
          onClick={() => onReject(item.id)}
        >
          <X className="h-3.5 w-3.5 mr-1" />
          {t("reject")}
        </Button>
      </div>
    </div>
  )
})
