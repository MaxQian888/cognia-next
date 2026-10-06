"use client"

/**
 * The one failure state for rich blocks (ADR-0218). A malformed mermaid
 * graph, a KaTeX error, a renderer crash and an invalid chart payload used to
 * draw three different destructive boxes; they now draw this one, in the same
 * frame metrics as a working block so a failure does not shift the layout.
 */

import { AlertTriangleIcon } from "lucide-react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export interface RichBlockErrorProps {
  title: ReactNode
  /** Parser / renderer message, shown in mono. */
  detail?: ReactNode
  /** A retry button or a "show source" toggle. */
  action?: ReactNode
  /** Source the block failed on, shown collapsed under the message. */
  children?: ReactNode
  className?: string
}

export function RichBlockError({
  title,
  detail,
  action,
  children,
  className,
}: RichBlockErrorProps) {
  return (
    <div
      role="alert"
      data-rich-block-error
      className={cn(
        "not-typeset my-(--rich-block-gap) min-w-0 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm",
        className
      )}
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-destructive">{title}</p>
          {detail ? (
            <p className="break-words font-mono text-xs text-muted-foreground">{detail}</p>
          ) : null}
        </div>
        {action ? (
          <div className="shrink-0">
            <TooltipProvider>{action}</TooltipProvider>
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-2">{children}</div> : null}
    </div>
  )
}
