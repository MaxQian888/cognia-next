import type { Meta, StoryObj } from "@storybook/nextjs"

import { BreakdownBarPanel } from "./breakdown-bar-panel"
import { panelById } from "./panel-registry"
import { makeBreakdownRows } from "@/lib/storybook/fixtures/observability"

// `BreakdownBarPanel` renders a Top-N horizontal bar breakdown by a dimension.
// Pure props-only. Stories cover a populated breakdown and the empty branch.
const meta = {
  title: "Observability/BreakdownBarPanel",
  component: BreakdownBarPanel,
  args: {
    panel: panelById("bd-surface")!,
    rows: makeBreakdownRows("surface"),
  },
  decorators: [
    (Story) => (
      <div className="h-[260px] w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BreakdownBarPanel>

export default meta
type Story = StoryObj<typeof meta>

export const BySurface: Story = {}

export const ByTool: Story = {
  args: { rows: makeBreakdownRows("tool") },
}

export const Empty: Story = {
  args: { rows: [] },
}
