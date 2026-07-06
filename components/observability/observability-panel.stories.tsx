import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ObservabilityPanel } from "./observability-panel"
import { panelById } from "./panel-registry"
import { makeSeries } from "@/lib/storybook/fixtures/observability"
import { DEFAULT_THRESHOLDS } from "@/lib/observability/thresholds"

// `ObservabilityPanel` maps a panel definition to its concrete panel component,
// feeding it the right slice of the shared derived series. Pure dispatch.
// Stories exercise each panel kind through the dispatch.
const series = makeSeries()

const meta = {
  title: "Observability/ObservabilityPanel",
  component: ObservabilityPanel,
  args: {
    panel: panelById("kpi-cost")!,
    series,
    editMode: false,
    onSelectTrace: fn(),
    thresholds: DEFAULT_THRESHOLDS,
    filters: {},
    onFilterValue: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[300px] w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ObservabilityPanel>

export default meta
type Story = StoryObj<typeof meta>

export const StatKind: Story = {}

export const TimeSeriesKind: Story = {
  args: { panel: panelById("ts-latency")! },
}

export const DonutKind: Story = {
  args: { panel: panelById("bd-model")! },
}

export const BarKind: Story = {
  args: { panel: panelById("bd-surface")! },
}

export const TracesKind: Story = {
  args: { panel: panelById("traces")! },
}

export const EditMode: Story = {
  args: { panel: panelById("ts-cost")!, editMode: true },
}
