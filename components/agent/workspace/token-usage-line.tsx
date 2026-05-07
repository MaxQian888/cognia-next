"use client"

import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, SigmaIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SubAgentTokenUsage } from "@/types/agent/sub-agent"

export interface TokenUsageLineProps {
  usage: Partial<SubAgentTokenUsage> | undefined | null
  className?: string
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(2)}k`
  return n.toLocaleString()
}

export function TokenUsageLine({ usage, className }: TokenUsageLineProps) {
  const t = useTranslations("agentTeamsWorkspace.chat.tokenUsage")
  if (!usage) return null
  const inTok = usage.promptTokens ?? 0
  const outTok = usage.completionTokens ?? 0
  const total = usage.totalTokens ?? inTok + outTok
  if (inTok === 0 && outTok === 0 && total === 0) return null

  return (
    <div
      data-testid="token-usage-line"
      className={cn("inline-flex items-center gap-2 text-[10px] text-muted-foreground", className)}
      aria-label={t("label")}
    >
      <span className="inline-flex items-center gap-0.5" title={t("input")}>
        <ArrowDownIcon className="size-2.5" aria-hidden />
        <span data-testid="token-usage-input">{formatNumber(inTok)}</span>
      </span>
      <span className="inline-flex items-center gap-0.5" title={t("output")}>
        <ArrowUpIcon className="size-2.5" aria-hidden />
        <span data-testid="token-usage-output">{formatNumber(outTok)}</span>
      </span>
      <span className="inline-flex items-center gap-0.5" title={t("total")}>
        <SigmaIcon className="size-2.5" aria-hidden />
        <span data-testid="token-usage-total">{formatNumber(total)}</span>
      </span>
    </div>
  )
}
