"use client"

/**
 * The "Worked for 13m 8s ›" row a finished turn folds its process into.
 *
 * Which parts are process is decided by `foldTurnParts` (`lib/chat/turn-fold.ts`);
 * this is only the disclosure. Closed it is one muted line over a hairline
 * rule, so the conclusion under it reads as the answer. Open it shows the
 * ordinary grouped transcript the turn rendered while it ran. The body mounts
 * only while open: a long turn's tool cards cost nothing until asked for.
 */

import { useState, type ReactNode } from "react"
import { ChevronRightIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { ReadingCollapse } from "@/components/chat/motion/motion-reveal"
import { formatWorkedDuration, type TurnFold } from "@/lib/chat/turn-fold"
import { cn } from "@/lib/utils"

export interface TurnProcessFoldProps {
  fold: Pick<TurnFold, "toolCount" | "failedCount" | "reasoningCount">
  /** Sealed turn duration (`metadata.run.durationMs`); absent on imported turns. */
  durationMs?: number
  /** The folded parts, rendered only while open. */
  children: ReactNode
}

export function TurnProcessFold({ fold, durationMs, children }: TurnProcessFoldProps) {
  const t = useTranslations("chat.turnFold")
  const [open, setOpen] = useState(false)
  const steps = fold.toolCount + fold.reasoningCount
  const label =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
      ? t("workedFor", { duration: formatWorkedDuration(durationMs) })
      : t("worked", { count: steps })

  return (
    <div className="not-prose mb-2 w-full" data-testid="turn-process-fold" data-open={open}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? t("collapse", { label }) : t("expand", { label })}
        className="group flex w-full items-center gap-1.5 border-b border-border/60 pb-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        data-testid="turn-process-fold-toggle"
      >
        <span className="min-w-0 truncate" data-testid="turn-process-fold-label">
          {label}
        </span>
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        {fold.failedCount > 0 ? (
          <span
            className="ml-auto shrink-0 text-[11px] font-medium text-red-600 dark:text-red-500"
            data-testid="turn-process-fold-failed"
          >
            {t("failed", { count: fold.failedCount })}
          </span>
        ) : null}
      </button>
      <ReadingCollapse open={open}>
        <div className="pt-2" data-testid="turn-process-fold-body">
          {children}
        </div>
      </ReadingCollapse>
    </div>
  )
}
