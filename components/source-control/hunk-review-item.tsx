"use client"

/**
 * One hunk in the source-control review list: Accept / Reject toggles, an
 * optional comment, and the same direct actions (Stage / Discard) the diff
 * toolbar offers for the change the reader is on — one list of actions, two
 * places to reach it, never two meanings. Decisions are advisory UI state
 * (persisted in the diff-review store) until the user stages the accepted
 * ones; a direct action applies now.
 *
 * The hunk's lines are not drawn here. They are in the diff right above, and
 * "Show in diff" takes the reader there; the item the reader is on in the
 * diff is marked and scrolled into view, so list and diff stay one place.
 * UX adapted from `components/artifacts/review-hunk-item.tsx`, driven by the
 * Rust-parsed {@link GitHunk}.
 */

import { memo, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, LocateFixedIcon, MessageSquarePlus, SparklesIcon, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import type { GitHunk, HunkAiFinding, HunkFindingSeverity } from "@/types/git"
import type { HunkDecision } from "@/lib/git/hunk-review"
import { HUNK_ACTION_ICON, type HunkAction } from "./hunk-actions"

interface Props {
  hunk: GitHunk
  index: number
  decision: HunkDecision
  comment?: string
  ai?: HunkAiFinding
  onDecision: (index: number, decision: HunkDecision) => void
  onComment: (index: number, comment: string) => void
  /** Stage / Unstage / Discard — the same actions as the diff's navigator. */
  actions?: HunkAction[]
  /** Bring this hunk into view in the diff. */
  onReveal?: (index: number) => void
  /** The diff's reader is on this hunk. */
  current?: boolean
  disabled?: boolean
  density?: "compact" | "touch"
}

/** Severity → border/text accent for the AI finding banner. */
const SEVERITY_CLASS: Record<HunkFindingSeverity, string> = {
  info: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  critical: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
}

export const HunkReviewItem = memo(function HunkReviewItem({
  hunk,
  index,
  decision,
  comment,
  ai,
  onDecision,
  onComment,
  actions = [],
  onReveal,
  current = false,
  disabled,
  density = "compact",
}: Props) {
  const t = useTranslations("sourceControl.review")
  const [commenting, setCommenting] = useState(Boolean(comment))
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Follow the diff: the hunk the reader moved to scrolls into the list.
  useEffect(() => {
    if (current) rootRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [current])
  const touchTarget = density === "touch" && "h-11 min-w-11"

  // Toggling an already-set decision clears it back to undecided.
  const toggle = (next: HunkDecision) => onDecision(index, decision === next ? "undecided" : next)

  return (
    <div
      ref={rootRef}
      data-testid="hunk-review-item"
      data-decision={decision}
      data-current={current ? "true" : undefined}
      aria-current={current ? "true" : undefined}
      className={cn(
        "space-y-2 rounded-lg border bg-card p-3 transition-all",
        decision === "accepted" && "border-success/40",
        decision === "rejected" && "border-destructive/40 opacity-80",
        current && "ring-1 ring-primary/60"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        {onReveal ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              "h-auto min-w-0 justify-start gap-1 px-1 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground",
              density === "touch" && "min-h-11 px-2"
            )}
            title={`${t("showInDiff")} · ${hunk.header}`}
            onClick={() => onReveal(index)}
            data-testid="hunk-reveal"
          >
            <LocateFixedIcon className="size-3 shrink-0" />
            <span className="truncate">{t("hunkLabel", { line: hunk.newStart })}</span>
          </Button>
        ) : (
          <span className="truncate font-mono text-xs text-muted-foreground" title={hunk.header}>
            {t("hunkLabel", { line: hunk.newStart })}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={decision === "accepted" ? "default" : "outline"}
            aria-pressed={decision === "accepted"}
            aria-label={t("accept")}
            disabled={disabled}
            className={cn(touchTarget)}
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
            className={cn(touchTarget)}
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
            className={cn(touchTarget)}
            onClick={() => setCommenting((v) => !v)}
            data-testid="hunk-comment-toggle"
          >
            <MessageSquarePlus className="size-3.5" />
          </Button>
          {actions.length > 0 ? (
            <div className="ml-0.5 flex items-center gap-0.5 border-l pl-1">
              {actions.map((action) => {
                const Icon = HUNK_ACTION_ICON[action.icon]
                return (
                  <Button
                    key={action.icon}
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={action.label}
                    title={action.label}
                    disabled={disabled}
                    className={cn(touchTarget)}
                    onClick={() => action.onClick(hunk)}
                    data-testid={`hunk-review-${action.icon}`}
                  >
                    <Icon className="size-3.5" />
                  </Button>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>

      {ai && (
        <div
          className={cn(
            "flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-snug",
            SEVERITY_CLASS[ai.severity]
          )}
          data-testid="hunk-ai-finding"
          data-severity={ai.severity}
        >
          <SparklesIcon className="mt-0.5 size-3 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium uppercase">{t(`ai.severity.${ai.severity}`)}</span>
            <span className="ml-1.5 break-words">{ai.note}</span>
          </div>
        </div>
      )}

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
