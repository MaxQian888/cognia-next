import type { Meta, StoryObj } from "@storybook/nextjs"

import { TimeSeriesPanel } from "./time-series-panel"
import { panelById } from "./panel-registry"
import { makeSeries, emptySeries } from "@/lib/storybook/fixtures/observability"

// `TimeSeriesPanel` plots the series named by `panel.seriesKind` (cost / request
// rate / error rate / latency percentiles / token throughput) as a recharts
// area or line chart. Pure props-only. Stories cover each series kind plus the
// empty (no-data) window.
const series = makeSeries()

const meta = {
  title: "Observability/TimeSeriesPanel",
  component: TimeSeriesPanel,
  args: {
    panel: panelById("ts-cost")!,
    series,
  },
  decorators: [
    (Story) => (
      <div className="h-[280px] w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TimeSeriesPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Cost: Story = {}

export const RequestRate: Story = {
  args: { panel: panelById("ts-rate")! },
}

export const ErrorRate: Story = {
  args: { panel: panelById("ts-errors")! },
}

export const LatencyPercentiles: Story = {
  args: { panel: panelById("ts-latency")! },
}

export const TokenThroughput: Story = {
  args: { panel: panelById("ts-tokens")! },
}

export const Empty: Story = {
  args: { series: emptySeries() },
}
