import type { Meta, StoryObj } from "@storybook/nextjs"

import { DonutPanel } from "./donut-panel"
import { panelById } from "./panel-registry"
import { makeBreakdownRows } from "@/lib/storybook/fixtures/observability"

// `DonutPanel` renders the share of spans by a dimension as a donut + compact
// legend. Pure props-only. Stories cover a populated breakdown and the empty
// (no-data) branch.
const meta = {
  title: "Observability/DonutPanel",
  component: DonutPanel,
  args: {
    panel: panelById("bd-model")!,
    rows: makeBreakdownRows("model"),
  },
  decorators: [
    (Story) => (
      <div className="h-[260px] w-[380px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DonutPanel>

export default meta
type Story = StoryObj<typeof meta>

export const ByModel: Story = {}

export const BySurface: Story = {
  args: { rows: makeBreakdownRows("surface") },
}

export const Empty: Story = {
  args: { rows: [] },
}
