import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatPanel } from "./stat-panel"
import { panelById } from "./panel-registry"
import { makeKpis } from "@/lib/storybook/fixtures/observability"

// `StatPanel` renders a single threshold-colored KPI number resolved from the
// window KPIs + its panel definition. Pure props-only. Stories pick different
// stat panels from the registry and drive the threshold coloring via KPIs.
const costPanel = panelById("kpi-cost")!
const errorPanel = panelById("kpi-errors")!
const latencyPanel = panelById("kpi-latency")!
const spansPanel = panelById("kpi-spans")!

const meta = {
  title: "Observability/StatPanel",
  component: StatPanel,
  args: {
    panel: spansPanel,
    kpis: makeKpis(),
  },
  decorators: [
    (Story) => (
      <div className="h-[120px] w-[220px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StatPanel>

export default meta
type Story = StoryObj<typeof meta>

export const TotalSpans: Story = {}

export const Cost: Story = {
  args: { panel: costPanel },
}

export const ErrorRateCrit: Story = {
  args: {
    panel: errorPanel,
    kpis: { ...makeKpis(), errorRate: 0.18 },
  },
}

export const LatencyWarn: Story = {
  args: {
    panel: latencyPanel,
    kpis: { ...makeKpis(), p95LatencyMs: 8_400 },
  },
}
