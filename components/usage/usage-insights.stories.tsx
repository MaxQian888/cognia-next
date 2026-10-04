import type { Meta, StoryObj } from "@storybook/nextjs"
import { CoinsIcon, DatabaseZapIcon, GaugeIcon, HashIcon, RepeatIcon } from "lucide-react"

import { StatCard } from "@/components/scheduler/stat-card"
import type { SessionUsageRow } from "@/lib/db/session-usage"
import {
  aggregateByDay,
  filterByRange,
  filterPreviousRange,
  formatBucketCost,
} from "@/lib/usage/session-analytics"
import {
  buildActivityMatrix,
  buildDailyStack,
  compareSpend,
  detectSpendSpikes,
  estimateCacheSavings,
  forecastMonthSpend,
  summarizeTurnDistribution,
} from "@/lib/usage/usage-insights"
import { summarizeSpend } from "@/lib/usage/usage-report"
import { formatTokens } from "@/types/system/usage"
import { UsageActivityMatrix } from "./usage-activity-matrix"
import { UsageDelta } from "./usage-delta"
import { UsageEfficiencyPanel } from "./usage-efficiency-panel"
import { UsageForecastView } from "./usage-forecast-panel"
import { UsageStackedCostChart } from "./usage-stacked-cost-chart"

// The second-order read-outs the Usage dashboard gained, fed sixty days of
// deterministic synthetic rows through the real pure helpers — the same calls
// `usage-tab.tsx` makes. The tab itself only renders inside the desktop shell.

const NOW = new Date(2026, 9, 20, 16, 0).getTime()
const DAY = 86_400_000
const MODELS = ["claude-sonnet-4-6", "claude-opus-4-7", "gpt-4.1", "deepseek-v3"] as const
const SURFACES = ["chat", "chat", "chat", "workflow", "agent-team", "connector"] as const
const pricing = (_p: string | undefined, model: string | undefined) =>
  model?.startsWith("claude-opus")
    ? { promptPer1M: 15, completionPer1M: 75, cachedInputPer1M: 1.5 }
    : model?.startsWith("deepseek")
      ? { promptPer1M: 0.27, completionPer1M: 1.1 }
      : { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 }

function rows(): SessionUsageRow[] {
  const out: SessionUsageRow[] = []
  let seq = 0
  for (let day = 0; day < 60; day += 1) {
    const weekday = new Date(NOW - day * DAY).getDay()
    // Busier on weekdays, a spike five days ago, ramp-up in the recent month.
    const turns =
      (weekday === 0 || weekday === 6 ? 6 : 22) + (day < 30 ? 8 : 0) + (day === 5 ? 60 : 0)
    for (let i = 0; i < turns; i += 1) {
      seq += 1
      const hour = [9, 10, 11, 14, 15, 16, 17, 21, 2][(seq * 7) % 9]
      const at = new Date(NOW - day * DAY)
      at.setHours(hour, (seq * 13) % 60, 0, 0)
      const model = MODELS[(seq * 5) % (day === 5 ? 2 : 4)]
      const context = 8_000 + ((seq * 7919) % 90_000)
      out.push({
        messageId: `m${seq}`,
        sessionId: `s${Math.floor(seq / 9)}`,
        at: at.getTime(),
        model,
        providerId: model.startsWith("claude")
          ? "anthropic"
          : model.startsWith("gpt")
            ? "openai"
            : "deepseek",
        surface: SURFACES[seq % SURFACES.length],
        inputTokens: Math.round(context * 0.3),
        cacheReadTokens: Math.round(context * 0.65),
        cacheCreationTokens: Math.round(context * 0.05),
        outputTokens: 300 + ((seq * 211) % 2_200),
        durationMs: 2_000 + ((seq * 1_733) % 26_000),
        costUsd: 0,
      })
    }
  }
  return out
}

const ALL = rows()
const RANGE = 30
const current = filterByRange(ALL, RANGE, NOW)
const totals = summarizeSpend(current, pricing)
const change = compareSpend(totals, summarizeSpend(filterPreviousRange(ALL, RANGE, NOW), pricing))

function Dashboard() {
  const speed = totals.durationMs > 0 ? totals.outputTokens / (totals.durationMs / 1000) : 0
  return (
    <div className="max-w-5xl space-y-6 p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          size="sm"
          label="Total tokens"
          value={formatTokens(
            totals.inputTokens +
              totals.outputTokens +
              totals.cacheReadTokens +
              totals.cacheCreationTokens
          )}
          icon={<HashIcon className="h-5 w-5 text-blue-500" />}
          valueClassName="text-blue-500"
          accentGradient="from-blue-500 to-sky-400"
          iconBgClassName="bg-blue-500/10"
          footer={<UsageDelta change={change.tokens} />}
        />
        <StatCard
          size="sm"
          label="Total cost"
          value={formatBucketCost(totals.costUsd, totals.unpricedTurns, totals.turns)}
          icon={<CoinsIcon className="h-5 w-5 text-violet-500" />}
          valueClassName="text-violet-500"
          accentGradient="from-violet-500 to-purple-400"
          iconBgClassName="bg-violet-500/10"
          footer={<UsageDelta change={change.cost} polarity="lower-is-better" />}
        />
        <StatCard
          size="sm"
          label="Turns"
          value={String(totals.turns)}
          icon={<RepeatIcon className="h-5 w-5 text-emerald-500" />}
          valueClassName="text-emerald-500"
          accentGradient="from-emerald-500 to-green-400"
          iconBgClassName="bg-emerald-500/10"
          footer={<UsageDelta change={change.turns} />}
        />
        <StatCard
          size="sm"
          label="Cache hit rate"
          value={`${Math.round((totals.cacheHitRate ?? 0) * 100)}%`}
          icon={<DatabaseZapIcon className="h-5 w-5 text-amber-500" />}
          valueClassName="text-amber-500"
          accentGradient="from-amber-500 to-yellow-400"
          iconBgClassName="bg-amber-500/10"
          footer={
            <UsageDelta change={change.cacheHitPoints} unit="points" polarity="higher-is-better" />
          }
        />
        <StatCard
          size="sm"
          label="Speed"
          value={`${Math.round(speed)} tok/s`}
          icon={<GaugeIcon className="h-5 w-5 text-cyan-500" />}
          valueClassName="text-cyan-500"
          accentGradient="from-cyan-500 to-sky-400"
          iconBgClassName="bg-cyan-500/10"
          footer={<UsageDelta change={change.speed} polarity="higher-is-better" />}
        />
      </div>

      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-medium">Month-end forecast</h3>
        <UsageForecastView
          forecast={forecastMonthSpend(ALL, NOW, pricing)}
          now={NOW}
          monthlyLimitUsd={250}
        />
      </section>

      <section className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-medium">Cost over time — stacked by model</h3>
        <UsageStackedCostChart
          stack={buildDailyStack(current, (r) => r.model ?? "", RANGE, NOW, {
            limit: 4,
            resolve: pricing,
          })}
          labelFor={(key) => key}
          reduce
        />
        <ul className="text-xs text-muted-foreground">
          {detectSpendSpikes(aggregateByDay(current, pricing)).map((s) => (
            <li key={s.date}>
              Spike: {s.date} cost ${s.costUsd.toFixed(2)}, {s.ratio.toFixed(1)}× a typical day
              (median ${s.medianUsd.toFixed(2)})
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="text-sm font-medium">Efficiency</h3>
          <UsageEfficiencyPanel
            savings={estimateCacheSavings(current, pricing)}
            distribution={summarizeTurnDistribution(current, pricing)}
          />
        </section>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="text-sm font-medium">Activity pattern</h3>
          <UsageActivityMatrix matrix={buildActivityMatrix(current, pricing)} />
        </section>
      </div>
    </div>
  )
}

const meta = {
  title: "Usage/DashboardInsights",
  component: Dashboard,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Dashboard>

export default meta
type Story = StoryObj<typeof meta>

export const ThirtyDays: Story = {}
