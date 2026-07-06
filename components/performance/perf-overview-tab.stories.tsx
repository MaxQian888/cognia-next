import type { Meta, StoryObj } from "@storybook/nextjs"

import { PerfOverviewTab } from "./perf-overview-tab"
import { makeHistory } from "@/lib/storybook/fixtures/performance"

// Task-Manager "Performance" layout: a left rail of metric tiles + memory
// pressure gauge, and a large rolling graph for the selected metric. Click the
// tiles to swap the graph series.
const meta = {
  title: "Performance/PerfOverviewTab",
  component: PerfOverviewTab,
  args: { history: makeHistory(40) },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[520px] w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PerfOverviewTab>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Empty: Story = {
  args: { history: [] },
}
