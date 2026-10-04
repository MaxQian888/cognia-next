"use client"

/**
 * What the conversation's tokens were made of: fresh input, output, cache
 * reads and cache writes, as one stacked bar with a legend of counts and
 * shares.
 *
 * The four classes are billed at very different rates (a cache read costs a
 * tenth of fresh input, output several times more), so their proportions
 * explain a bill better than the total does. Reasoning is a SUBSET of output,
 * so it is noted beside output rather than drawn as a fifth slice that would
 * double-count it.
 */

import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { formatTokens } from "@/types/system/usage"

export interface TokenMix {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  reasoningTokens: number
}

const SEGMENTS = [
  { id: "input", field: "inputTokens", className: "bg-chart-1" },
  { id: "output", field: "outputTokens", className: "bg-chart-2" },
  { id: "cacheRead", field: "cacheReadTokens", className: "bg-chart-3" },
  { id: "cacheWrite", field: "cacheCreationTokens", className: "bg-chart-4" },
] as const

function share(part: number, whole: number): string {
  if (whole <= 0) return "0%"
  const pct = (part / whole) * 100
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`
}

export function TokenMixBar({ mix }: { mix: TokenMix }) {
  const t = useTranslations("contextWorkbench.sessionUsage.tokenMix")
  const total = mix.inputTokens + mix.outputTokens + mix.cacheReadTokens + mix.cacheCreationTokens

  if (total <= 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="token-mix-empty">
        {t("empty")}
      </p>
    )
  }

  return (
    <div className="space-y-2" data-testid="token-mix">
      <div
        className="flex h-3 w-full gap-px overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t("aria", { total: formatTokens(total) })}
      >
        {SEGMENTS.map((segment) =>
          mix[segment.field] > 0 ? (
            <div
              key={segment.id}
              className={cn(segment.className)}
              style={{ width: `${Math.max((mix[segment.field] / total) * 100, 0.75)}%` }}
              data-segment={segment.id}
            />
          ) : null
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
        {SEGMENTS.map((segment) => (
          <div key={segment.id} className="flex min-w-0 items-center gap-1.5 text-[11px]">
            <span className={cn("size-2 shrink-0 rounded-sm", segment.className)} aria-hidden />
            <dt className="min-w-0 flex-1 truncate text-muted-foreground">{t(segment.id)}</dt>
            <dd className="shrink-0 font-mono tabular-nums" data-testid={`token-mix-${segment.id}`}>
              {formatTokens(mix[segment.field])}
              <span className="ml-1 text-muted-foreground">{share(mix[segment.field], total)}</span>
            </dd>
          </div>
        ))}
      </dl>
      {mix.reasoningTokens > 0 ? (
        <p className="text-[10px] text-muted-foreground" data-testid="token-mix-reasoning">
          {t("reasoning", {
            tokens: formatTokens(mix.reasoningTokens),
            pct: share(mix.reasoningTokens, mix.outputTokens),
          })}
        </p>
      ) : null}
    </div>
  )
}
