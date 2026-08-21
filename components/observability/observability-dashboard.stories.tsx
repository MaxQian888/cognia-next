import type { Meta, StoryObj } from "@storybook/nextjs"

import { ObservabilityDashboard } from "./observability-dashboard"
import { defaultLayouts } from "./panel-registry"
import { DEFAULT_THRESHOLDS } from "@/lib/observability/thresholds"
import { emptySeries, makeSeries } from "@/lib/storybook/fixtures/observability"

// `ObservabilityDashboard` is the Dashboard sub-view of `/logs` → Traces: a
// controlled pane fed the derived series, the resolved thresholds and the panel
// layout by the channel, which owns the time range, the filters and the single
// Dexie read. Stories therefore pass props rather than seeding Dexie.
const meta = {
  title: "Observability/Dashboard",
  component: ObservabilityDashboard,
  parameters: { layout: "fullscreen" },
  args: {
    series: makeSeries(),
    layouts: defaultLayouts(),
    editMode: false,
    hiddenPanels: [],
    thresholds: DEFAULT_THRESHOLDS,
    filters: {},
    empty: false,
    onLayoutChange: () => {},
    onFilterValue: () => {},
  },
  decorators: [
    (Story) => (
      <div className="flex h-[760px] w-full flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ObservabilityDashboard>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

/** Layout editing unlocked — every panel grows its drag handle. */
export const EditMode: Story = {
  args: { editMode: true },
}

/** The whole window is empty (as opposed to filters hiding everything). */
export const Empty: Story = {
  args: { series: emptySeries(), empty: true, onWidenRange: () => {} },
}
