"use client"

/**
 * One conversation's spend, turn by turn.
 *
 * Bars are each billed turn's cost; the line is the context the model had to
 * read on that turn. Drawn together they show the usual reason a long chat gets
 * expensive — the context creeping up — which an aggregate cost figure hides.
 * Below the chart: the turns that carried the bill (each one a jump back into
 * the transcript when it is a chat turn) and where this conversation ranks
 * among the user's recent ones.
 *
 * Every number arrives precomputed from `lib/usage/session-cost-profile.ts`
 * (via `analyzeSession` and `useSessionCostRank`); this file only draws.
 */

import { useMemo } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { CornerDownRightIcon } from "lucide-react"
import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { useThemeColors } from "@/hooks/logging/use-theme-colors"
import { paletteColor } from "@/lib/observability/chart-palette"
import { CHART_MARGINS, TOOLTIP_STYLE } from "@/lib/observability/chart-config"
import {
  SESSION_RANK_WINDOW_DAYS,
  contextGrowth,
  costConcentration,
  topCostlyTurns,
  type SessionCostRank,
  type TurnCostPoint,
} from "@/lib/usage/session-cost-profile"
import { formatCost, formatTokens } from "@/types/system/usage"

/** Turns listed under "where the money went". */
const TOP_TURNS = 3
/** One turn carrying at least this share of the bill is worth saying out loud. */
const CONCENTRATION_NOTE = 0.3
/** Context growth worth calling out, as a last÷first ratio. */
const GROWTH_NOTE = 2

export interface SessionCostTimelineProps {
  points: readonly TurnCostPoint[]
  rank: SessionCostRank | null
  /** Jump back into the transcript. Omitted where there is no transcript to jump to. */
  onJump?: (messageId: string) => void
  /** Hide the built-in heading when the host already titles the section. */
  hideTitle?: boolean
}

export function SessionCostTimeline({
  points,
  rank,
  onJump,
  hideTitle = false,
}: SessionCostTimelineProps) {
  const t = useTranslations("sessionInsights.costTimeline")
  const format = useFormatter()
  const colors = useThemeColors()
  const { reduce } = useFlowMotion()

  const data = useMemo(
    () =>
      points.map((p) => ({
        turn: p.index,
        cost: p.costKnown ? p.costUsd : null,
        context: p.contextTokens,
      })),
    [points]
  )
  const top = useMemo(() => topCostlyTurns(points, TOP_TURNS), [points])
  const concentration = useMemo(() => costConcentration(points), [points])
  const growth = useMemo(() => contextGrowth(points), [points])
  const concentrated = concentration != null && points.length >= 3 ? concentration : null
  const topTurn = top[0]

  if (points.length === 0) return null

  return (
    <section className="space-y-2" data-testid="session-cost-timeline">
      {hideTitle ? null : (
        <p className="text-[10px] uppercase text-muted-foreground">{t("title")}</p>
      )}
      <div className="h-40" data-testid="session-cost-timeline-chart">
        <ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={1}
          minHeight={1}
          initialDimension={{ width: 320, height: 160 }}
        >
          <ComposedChart data={data} margin={CHART_MARGINS.compact}>
            <XAxis dataKey="turn" tick={{ fontSize: 10 }} />
            <YAxis
              yAxisId="cost"
              width={44}
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => (Number(v) === 0 ? "0" : formatCost(Number(v)))}
            />
            <YAxis
              yAxisId="context"
              orientation="right"
              width={40}
              tick={{ fontSize: 10 }}
              tickFormatter={(v) => formatTokens(Number(v))}
            />
            <Tooltip
              contentStyle={TOOLTIP_STYLE.contentStyle}
              labelStyle={TOOLTIP_STYLE.labelStyle}
              itemStyle={TOOLTIP_STYLE.itemStyle}
              labelFormatter={(v) => t("turn", { index: Number(v) })}
              formatter={(value, name) =>
                name === t("context")
                  ? [formatTokens(Number(value)), name]
                  : [value == null ? "—" : formatCost(Number(value)), name]
              }
            />
            <Bar
              yAxisId="cost"
              dataKey="cost"
              name={t("cost")}
              fill={paletteColor(colors, 0)}
              radius={[3, 3, 0, 0]}
              isAnimationActive={!reduce}
            />
            <Line
              yAxisId="context"
              dataKey="context"
              name={t("context")}
              type="linear"
              stroke={paletteColor(colors, 2)}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={!reduce}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <ul className="space-y-1 text-xs text-muted-foreground" data-testid="session-cost-notes">
        {rank ? (
          <li data-testid="session-cost-rank">
            {t("rank", {
              pct: rank.percentile,
              days: SESSION_RANK_WINDOW_DAYS,
              peers: rank.peers,
              median: formatCost(rank.medianUsd),
            })}
          </li>
        ) : null}
        {concentrated != null && concentrated >= CONCENTRATION_NOTE && topTurn ? (
          <li data-testid="session-cost-concentration">
            {t("concentration", {
              index: topTurn.index,
              pct: Math.round(concentrated * 100),
            })}
          </li>
        ) : null}
        {growth != null && growth >= GROWTH_NOTE ? (
          <li data-testid="session-cost-growth">
            {t("growth", {
              ratio: growth >= 10 ? Math.round(growth) : growth.toFixed(1),
              from: formatTokens(points[0].contextTokens),
              to: formatTokens(points[points.length - 1].contextTokens),
            })}
          </li>
        ) : null}
      </ul>

      {top.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] uppercase text-muted-foreground">{t("priciest")}</p>
          <ul className="space-y-1" data-testid="session-cost-top-turns">
            {top.map((p) => (
              <li
                key={p.messageId}
                className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs"
                data-testid={`session-cost-top-turn-${p.index}`}
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">{t("turn", { index: p.index })}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {format.dateTime(new Date(p.at), { hour: "2-digit", minute: "2-digit" })}
                    {p.model ? ` · ${p.model}` : ""}
                    {" · "}
                    {t("contextShort", { tokens: formatTokens(p.contextTokens) })}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className="font-mono tabular-nums">{formatCost(p.costUsd)}</span>
                  {onJump && p.surface === "chat" ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => onJump(p.messageId)}
                      aria-label={t("jump", { index: p.index })}
                      title={t("jump", { index: p.index })}
                      data-testid={`session-cost-jump-${p.index}`}
                    >
                      <CornerDownRightIcon className="size-3.5" aria-hidden />
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
