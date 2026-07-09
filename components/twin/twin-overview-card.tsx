"use client"

/**
 * Visual overview of a twin's ingest activity. Surfaces:
 *
 *  • a 7-day chunk-growth area chart (X = day, Y = new chunks added);
 *  • a source-kind pie (document / chat / code / email);
 *  • a chunking-strategy bar chart (heading / paragraph / code / …) so the
 *    user can see if their format-routing is working as expected;
 *  • a status legend (parsed / pending / failed) tying back into the
 *    Sources tab.
 *
 * All charts are driven off Dexie liveQueries so the user sees live updates
 * as ingest jobs complete in another tab. Heavy aggregation runs through
 * `useMemo` so a chunk-table change only rebuilds the buckets, not the
 * recharts render tree.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { listTwinChunksByTwin } from "@/lib/db/twin-chunks"
import { listTwinSourcesByTwin } from "@/lib/db/twin-sources"
import type { ChunkingStrategyId, TwinChunk, TwinSource } from "@/types/twin"
import { TwinOverviewPluginSlot } from "./twin-plugin-slots"

const ONE_DAY_MS = 24 * 60 * 60 * 1000
const GROWTH_WINDOW_DAYS = 7

const KIND_COLORS: Record<TwinSource["kind"], string> = {
  document: "var(--chart-1)",
  chat: "var(--chart-2)",
  code: "var(--chart-3)",
  email: "var(--chart-4)",
}

const STRATEGY_COLOR = "var(--chart-1)"

const STATUS_VARIANT: Record<
  TwinSource["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  parsed: "default",
  parsing: "secondary",
  pending: "outline",
  failed: "destructive",
  deleted: "outline",
}

interface Props {
  twinId: string
}

export function TwinOverviewCard({ twinId }: Props) {
  const tCharts = useTranslations("twin.charts")
  const sources = useLiveQuery(() => listTwinSourcesByTwin(twinId), [twinId], [] as TwinSource[])
  const chunks = useLiveQuery(() => listTwinChunksByTwin(twinId), [twinId], [] as TwinChunk[])

  const growthSeries = useMemo(() => buildGrowthSeries(chunks), [chunks])
  const kindBreakdown = useMemo(() => buildKindBreakdown(sources), [sources])
  const strategyBreakdown = useMemo(() => buildStrategyBreakdown(chunks), [chunks])
  const statusBreakdown = useMemo(() => buildStatusBreakdown(sources), [sources])

  const growthConfig: ChartConfig = {
    chunks: { label: tCharts("growthChunks"), color: "var(--chart-1)" },
  }
  const strategyConfig: ChartConfig = {
    count: { label: tCharts("strategyChunks"), color: STRATEGY_COLOR },
  }

  return (
    <Card className="space-y-4 p-4">
      <header className="space-y-1">
        <h3 className="text-sm font-medium">{tCharts("title")}</h3>
        <p className="text-muted-foreground text-xs">{tCharts("description")}</p>
      </header>

      {/* Status row — quick scan of where the user is at. */}
      <div className="flex flex-wrap gap-2">
        {(["parsed", "parsing", "pending", "failed"] as const).map((status) => {
          const count = statusBreakdown[status] ?? 0
          if (count === 0) return null
          return (
            <Badge key={status} variant={STATUS_VARIANT[status]} className="font-normal">
              {tCharts(`status.${status}`)}: {count}
            </Badge>
          )
        })}
        {sources.length === 0 && (
          <span className="text-muted-foreground text-xs italic">{tCharts("noSources")}</span>
        )}
      </div>

      {/* Three-column chart strip; collapses to a single column on mobile. */}
      <div className="grid gap-4 @md/twin:grid-cols-2 @xl/twin:grid-cols-3">
        {/* Chunks growth area chart */}
        <div className="bg-muted/20 space-y-2 rounded-md border p-3">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {tCharts("growthHeading")}
          </p>
          <ChartContainer config={growthConfig} className="aspect-[2/1] w-full">
            <AreaChart accessibilityLayer data={growthSeries}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} fontSize={11} />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={11}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Area
                dataKey="chunks"
                type="monotone"
                fill="var(--color-chunks)"
                fillOpacity={0.4}
                stroke="var(--color-chunks)"
              />
            </AreaChart>
          </ChartContainer>
        </div>

        {/* Source kind pie */}
        <div className="bg-muted/20 space-y-2 rounded-md border p-3">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {tCharts("kindHeading")}
          </p>
          <ChartContainer config={{}} className="aspect-[2/1] w-full">
            <PieChart accessibilityLayer>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie
                data={kindBreakdown}
                dataKey="count"
                nameKey="kind"
                outerRadius="80%"
                label={(props) => {
                  // recharts' label prop is loosely typed; cast through unknown
                  // because the runtime entries are our `KindBucket` shape.
                  const entry = props as unknown as { kind?: string; count?: number }
                  return `${entry.kind ?? ""} (${entry.count ?? 0})`
                }}
              >
                {kindBreakdown.map((entry) => (
                  <Cell key={entry.kind} fill={KIND_COLORS[entry.kind]} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
        </div>

        {/* Strategy bar chart spans full width on lg */}
        <div className="bg-muted/20 space-y-2 rounded-md border p-3 @lg/twin:col-span-2">
          <p className="text-muted-foreground text-xs uppercase tracking-wide">
            {tCharts("strategyHeading")}
          </p>
          <ChartContainer config={strategyConfig} className="aspect-[3/1] w-full">
            <BarChart accessibilityLayer data={strategyBreakdown}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="strategy"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={11}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={11}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar dataKey="count" fill="var(--color-count)" radius={4} />
            </BarChart>
          </ChartContainer>
        </div>
      </div>

      <TwinOverviewPluginSlot
        twinId={twinId}
        sourceCount={sources.length}
        chunkCount={chunks.length}
      />
    </Card>
  )
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

interface GrowthBucket {
  day: string
  chunks: number
}

export function buildGrowthSeries(chunks: TwinChunk[]): GrowthBucket[] {
  // Bucketed end-exclusive: each `day` label spans midnight-to-midnight in
  // the user's local timezone. We back-fill empty days so a sparse twin
  // still shows the full 7-day axis.
  const today = startOfDay(Date.now())
  const buckets = new Map<number, number>()
  for (let i = GROWTH_WINDOW_DAYS - 1; i >= 0; i--) {
    buckets.set(today - i * ONE_DAY_MS, 0)
  }
  for (const chunk of chunks) {
    const day = startOfDay(chunk.createdAt)
    if (buckets.has(day)) {
      buckets.set(day, (buckets.get(day) ?? 0) + 1)
    }
  }
  return Array.from(buckets.entries()).map(([ts, count]) => ({
    day: formatDayLabel(ts),
    chunks: count,
  }))
}

interface KindBucket {
  kind: TwinSource["kind"]
  count: number
}

export function buildKindBreakdown(sources: TwinSource[]): KindBucket[] {
  const counts: Record<TwinSource["kind"], number> = {
    document: 0,
    chat: 0,
    code: 0,
    email: 0,
  }
  for (const s of sources) {
    if (s.status === "deleted") continue
    counts[s.kind] = (counts[s.kind] ?? 0) + 1
  }
  return (Object.entries(counts) as Array<[TwinSource["kind"], number]>)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, count }))
}

interface StrategyBucket {
  strategy: ChunkingStrategyId
  count: number
}

export function buildStrategyBreakdown(chunks: TwinChunk[]): StrategyBucket[] {
  const counts = new Map<ChunkingStrategyId, number>()
  for (const c of chunks) {
    counts.set(c.strategy, (counts.get(c.strategy) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([strategy, count]) => ({ strategy, count }))
    .sort((a, b) => b.count - a.count)
}

export function buildStatusBreakdown(
  sources: TwinSource[]
): Partial<Record<TwinSource["status"], number>> {
  const out: Partial<Record<TwinSource["status"], number>> = {}
  for (const s of sources) {
    out[s.status] = (out[s.status] ?? 0) + 1
  }
  return out
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatDayLabel(ts: number): string {
  const d = new Date(ts)
  // Locale-aware short label, e.g. "Mon 12" (en) / "周一" (zh).
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export const __TESTING__ = {
  buildGrowthSeries,
  buildKindBreakdown,
  buildStrategyBreakdown,
  buildStatusBreakdown,
}
