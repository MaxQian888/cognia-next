"use client"

/**
 * One hunk in the source-control review list: a collapsible diff preview plus
 * Accept / Reject toggles and an optional comment. Decisions are advisory UI
 * state (persisted in the diff-review store) until the user applies them.
 * UX adapted from `components/artifacts/review-hunk-item.tsx`, driven by the
 * Rust-parsed {@link GitHunk}.
 */

import { memo, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronDown, MessageSquarePlus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import type { GitHunk } from "@/types/git"
import type { HunkDecision } from "@/lib/git/hunk-review"

interface Props {
  hunk: GitHunk
  index: number
  decision: HunkDecision
  comment?: string
  onDecision: (index: number, decision: HunkDecision) => void
  onComment: (index: number, comment: string) => void
  disabled?: boolean
}

const LINE_CLASS: Record<string, string> = {
  add: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  context: "text-muted-foreground",
}

const LINE_PREFIX: Record<string, string> = { add: "+", del: "-", context: " " }

export const HunkReviewItem = memo(function HunkReviewItem({
  hunk,
  index,
  decision,
  comment,
  onDecision,
  onComment,
  disabled,
}: Props) {
  const t = useTranslations("sourceControl.review")
  const [open, setOpen] = useState(false)
  const [commenting, setCommenting] = useState(Boolean(comment))

  // Toggling an already-set decision clears it back to undecided.
  const toggle = (next: HunkDecision) => onDecision(index, decision === next ? "undecided" : next)

  return (
    <div
      data-testid="hunk-review-item"
      data-decision={decision}
      className={cn(
        "space-y-2 rounded-lg border bg-card p-3 transition-all",
        decision === "accepted" && "border-emerald-500/40",
        decision === "rejected" && "border-red-500/40 opacity-80"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground" title={hunk.header}>
          {t("hunkLabel", { line: hunk.newStart })}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={decision === "accepted" ? "default" : "outline"}
            aria-pressed={decision === "accepted"}
            aria-label={t("accept")}
            disabled={disabled}
            onClick={() => toggle("accepted")}
            data-testid="hunk-accept"
          >
            <Check className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant={decision === "rejected" ? "destructive" : "outline"}
            aria-pressed={decision === "rejected"}
            aria-label={t("reject")}
            disabled={disabled}
            onClick={() => toggle("rejected")}
            data-testid="hunk-reject"
          >
            <X className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t("addComment")}
            disabled={disabled}
            onClick={() => setCommenting((v) => !v)}
            data-testid="hunk-comment-toggle"
          >
            <MessageSquarePlus className="size-3.5" />
          </Button>
        </div>
      </div>

      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
            {t("viewChanges")}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="mt-1.5 max-h-60 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">
            {hunk.lines.map((line, i) => (
              <div key={i} className={LINE_CLASS[line.kind] ?? "text-muted-foreground"}>
                {(LINE_PREFIX[line.kind] ?? " ") + line.content}
              </div>
            ))}
          </pre>
        </CollapsibleContent>
      </Collapsible>

      {commenting && (
        <Textarea
          value={comment ?? ""}
          placeholder={t("commentPlaceholder")}
          aria-label={t("comment")}
          disabled={disabled}
          onChange={(e) => onComment(index, e.target.value)}
          className="min-h-16 text-xs"
          data-testid="hunk-comment"
        />
      )}
    </div>
  )
})
