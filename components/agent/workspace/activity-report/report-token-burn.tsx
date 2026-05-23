"use client"

/**
 * Cumulative token-burn area chart over the run's checkpoints. Reads token
 * deltas from checkpoint `data.tokens` (when present) and accumulates them.
 * Uses the shadcn Chart wrapper + Recharts.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { Card } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import type { TeamExecutionReport } from "@/types/agent/agent-team"

export interface ReportTokenBurnProps {
  report: TeamExecutionReport
}

const chartConfig: ChartConfig = {
  tokens: { label: "Tokens", color: "var(--chart-1)" },
}

interface Point {
  t: number
  tokens: number
}

function buildSeries(report: TeamExecutionReport): Point[] {
  let cumulative = 0
  const points: Point[] = []
  for (const cp of report.checkpoints) {
    const delta = typeof cp.data?.tokens === "number" ? (cp.data.tokens as number) : 0
    if (delta <= 0) continue
    cumulative += delta
    points.push({ t: new Date(cp.timestamp).getTime(), tokens: cumulative })
  }
  return points
}

export function ReportTokenBurn({ report }: ReportTokenBurnProps) {
  const t = useTranslations("agentTeamsWorkspace.activity.report.tokenBurn")
  const series = useMemo(() => buildSeries(report), [report])

  return (
    <Card className="space-y-2 p-3" data-testid="report-token-burn">
      <p className="text-sm font-medium">{t("title")}</p>
      {series.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("empty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <ChartContainer config={chartConfig} className="h-[160px] w-full">
          <AreaChart data={series}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={(v: number) => new Date(v).toLocaleTimeString()}
              tickLine={false}
              axisLine={false}
              fontSize={10}
            />
            <YAxis tickLine={false} axisLine={false} fontSize={10} width={36} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Area
              dataKey="tokens"
              type="monotone"
              fill="var(--color-tokens)"
              fillOpacity={0.2}
              stroke="var(--color-tokens)"
            />
          </AreaChart>
        </ChartContainer>
      )}
    </Card>
  )
}
