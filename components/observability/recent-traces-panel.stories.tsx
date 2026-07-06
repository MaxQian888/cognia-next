import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RecentTracesPanel } from "./recent-traces-panel"
import { panelById } from "./panel-registry"
import { makeTraceRows } from "@/lib/storybook/fixtures/observability"

// `RecentTracesPanel` is the recent-traces table; clicking a row asks the parent
// to open the waterfall drawer. Pure props-only. Stories cover a populated table
// (including an error-flagged row) and the empty branch.
const meta = {
  title: "Observability/RecentTracesPanel",
  component: RecentTracesPanel,
  args: {
    panel: panelById("traces")!,
    traces: makeTraceRows(),
    onSelectTrace: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[320px] w-[640px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RecentTracesPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Empty: Story = {
  args: { traces: [] },
}
