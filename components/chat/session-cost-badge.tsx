"use client"

/**
 * Per-session cost / token badge surfaced in the chat header.
 *
 * Hover or click to see the per-model breakdown sourced from the
 * `sessionUsage` Dexie table (Stage 2 of the ClaudeCode 完整化 plan). The
 * collapsed badge keeps showing the in-memory totals from the active
 * messages so the indicator updates as soon as a turn streams in — the
 * popover then enriches it with the persistent per-model split (tokens, cost,
 * throughput, generation time, reasoning tokens, and cache-hit rate).
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { CircleDollarSignIcon } from "lucide-react"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { listUsageForSession, type SessionUsageRow } from "@/lib/db/session-usage"
import type { UsageInfo } from "@/lib/claude/adapter"
import {
  cacheHitRate,
  formatDuration,
  formatPercent,
  formatTokensPerSec,
  tokensPerSecond,
} from "@/types/system/usage"
import { cn } from "@/lib/utils"

interface Props {
  sessionId: string
  /** Aggregated UsageInfo from the currently-loaded messages. */
  inMemoryUsage: UsageInfo
  /** Caller supplies the i18n-formatted tokens label so the badge stays a
   *  pure presentation component without taking a translations namespace. */
  tokensLabel: (input: string, output: string) => string
}

export function SessionCostBadge({ sessionId, inMemoryUsage, tokensLabel }: Props) {
  const t = useTranslations("chat.sessionCost")

  // Live read of every persisted row for this session. `useLiveQuery` returns
  // `undefined` until the first emission; treat that as "no data yet".
  const rows = useLiveQuery(() => listUsageForSession(sessionId), [sessionId])

  const breakdown = useMemo(() => buildBreakdown(rows ?? []), [rows])
  // Session throughput: summed output tokens ÷ summed generation time. `null`
  // when no persisted turn reported a duration → "—".
  const speed = tokensPerSecond(breakdown.outputTokens, breakdown.durationMs)

  const inputs = inMemoryUsage.inputTokens ?? 0
  const outputs = inMemoryUsage.outputTokens ?? 0
  const cost = inMemoryUsage.totalCostUsd ?? 0

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            "hidden h-auto items-center gap-1 px-1 py-0.5 text-xs font-normal text-muted-foreground sm:inline-flex",
            "hover:bg-muted/50 focus-visible:bg-muted/50"
          )}
          aria-label={t("trigger")}
          data-testid="session-cost-trigger"
        >
          <CircleDollarSignIcon className="size-3.5" />
          <span title={t("tokensTitle", { input: inputs, output: outputs })}>
            {tokensLabel(formatTokens(inputs), formatTokens(outputs))}
          </span>
          {cost > 0 && <span className="font-mono">· ${cost.toFixed(4)}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 max-w-[calc(100vw-2rem)] space-y-3 text-xs">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <dt className="text-muted-foreground">{t("turns")}</dt>
          <dd className="text-right font-mono" data-testid="cost-popover-turns">
            {breakdown.turns}
          </dd>
          <dt className="text-muted-foreground">{t("input")}</dt>
          <dd className="text-right font-mono">{formatTokens(breakdown.inputTokens)}</dd>
          <dt className="text-muted-foreground">{t("output")}</dt>
          <dd className="text-right font-mono">{formatTokens(breakdown.outputTokens)}</dd>
          {breakdown.cacheReadTokens + breakdown.cacheCreationTokens > 0 && (
            <>
              <dt className="text-muted-foreground">{t("cache")}</dt>
              <dd className="text-right font-mono">
                {t("cacheWriteShort")} {formatTokens(breakdown.cacheCreationTokens)} /{" "}
                {t("cacheReadShort")} {formatTokens(breakdown.cacheReadTokens)}
              </dd>
              <dt className="text-muted-foreground">{t("cacheHit")}</dt>
              <dd className="text-right font-mono" data-testid="cost-popover-cache-hit">
                {formatPercent(
                  cacheHitRate(breakdown.cacheReadTokens, breakdown.cacheCreationTokens)
                )}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("speed")}</dt>
          <dd className="text-right font-mono" data-testid="cost-popover-speed">
            {speed != null ? t("tokPerSec", { value: formatTokensPerSec(speed) }) : "—"}
          </dd>
          <dt className="text-muted-foreground">{t("duration")}</dt>
          <dd className="text-right font-mono">
            {breakdown.durationMs > 0 ? formatDuration(breakdown.durationMs) : "—"}
          </dd>
          {breakdown.reasoningTokens > 0 && (
            <>
              <dt className="text-muted-foreground">{t("reasoning")}</dt>
              <dd className="text-right font-mono">{formatTokens(breakdown.reasoningTokens)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("cost")}</dt>
          <dd className="text-right font-mono">${breakdown.costUsd.toFixed(4)}</dd>
        </dl>
        {breakdown.byModel.length === 0 ? (
          <p
            className="rounded border bg-muted/30 p-2 text-center italic text-muted-foreground"
            data-testid="cost-popover-empty"
          >
            {t("noModelData")}
          </p>
        ) : (
          <div className="space-y-1">
            <p className="text-muted-foreground">{t("byModelTitle")}</p>
            <ul className="space-y-1" data-testid="cost-popover-by-model">
              {breakdown.byModel.map((m) => {
                const modelSpeed = tokensPerSecond(m.outputTokens, m.durationMs)
                return (
                  <li key={m.model} className="flex items-center justify-between">
                    <span className="truncate font-mono text-[11px]" title={m.model}>
                      {m.model}
                    </span>
                    <span className="ml-2 shrink-0 font-mono">
                      {formatTokens(m.tokens)} · ${m.costUsd.toFixed(4)}
                      {modelSpeed != null && (
                        <> · {t("tokPerSec", { value: formatTokensPerSec(modelSpeed) })}</>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

interface Breakdown {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  /** Summed active generation time (ms) — pairs with output for throughput. */
  durationMs: number
  /** Summed reasoning / "thinking" tokens (subset of output). */
  reasoningTokens: number
  byModel: Array<{
    model: string
    tokens: number
    outputTokens: number
    durationMs: number
    costUsd: number
    turns: number
  }>
}

const EMPTY: Breakdown = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  reasoningTokens: 0,
  byModel: [],
}

function buildBreakdown(rows: SessionUsageRow[]): Breakdown {
  if (rows.length === 0) return { ...EMPTY, byModel: [] }
  const out: Breakdown = {
    turns: rows.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    reasoningTokens: 0,
    byModel: [],
  }
  const byModel = new Map<
    string,
    { tokens: number; outputTokens: number; durationMs: number; costUsd: number; turns: number }
  >()
  for (const r of rows) {
    out.inputTokens += r.inputTokens
    out.outputTokens += r.outputTokens
    out.cacheReadTokens += r.cacheReadTokens
    out.cacheCreationTokens += r.cacheCreationTokens
    out.costUsd += r.costUsd
    out.durationMs += r.durationMs
    out.reasoningTokens += r.reasoningTokens ?? 0
    const model = r.model && r.model.trim() ? r.model : "(unknown)"
    const slot = byModel.get(model) ?? {
      tokens: 0,
      outputTokens: 0,
      durationMs: 0,
      costUsd: 0,
      turns: 0,
    }
    slot.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens
    slot.outputTokens += r.outputTokens
    slot.durationMs += r.durationMs
    slot.costUsd += r.costUsd
    slot.turns += 1
    byModel.set(model, slot)
  }
  out.byModel = [...byModel.entries()]
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.model.localeCompare(b.model))
  return out
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export default SessionCostBadge
