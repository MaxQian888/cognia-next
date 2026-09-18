"use client"

import { useTranslations } from "next-intl"
import { SparklesIcon } from "lucide-react"

import type { ToolUseSummaryPart as ToolUseSummaryPartData } from "@/lib/claude/parts-extensions"

export interface ToolUseSummaryPartProps {
  part: ToolUseSummaryPartData
}

/** Claude-authored aggregate description of the preceding correlated tool calls. */
export function ToolUseSummaryPart({ part }: ToolUseSummaryPartProps) {
  const t = useTranslations("chat.agentFlow.toolSummary")
  if (!part.data.summary.trim()) return null

  return (
    // A recessive status line, not a card: the summary sits inside the
    // activity stream like the other quiet notices (muted text + icon).
    <aside
      className="not-prose my-1 flex items-start gap-1.5 px-1.5 text-xs text-muted-foreground"
      aria-label={t("ariaLabel")}
      data-testid="tool-use-summary"
    >
      <SparklesIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <div className="min-w-0">
        <div className="font-medium">{t("label")}</div>
        <p className="mt-0.5 text-foreground/80">{part.data.summary}</p>
      </div>
    </aside>
  )
}
