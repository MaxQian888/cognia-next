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
    <aside
      className="not-prose my-2 flex items-start gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm"
      aria-label={t("ariaLabel")}
      data-testid="tool-use-summary"
    >
      <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{t("label")}</div>
        <p className="mt-0.5 text-foreground/80">{part.data.summary}</p>
      </div>
    </aside>
  )
}
