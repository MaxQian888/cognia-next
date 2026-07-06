import type { Meta, StoryObj } from "@storybook/nextjs"

import { MobileSchedulerStatStrip } from "./mobile-scheduler-stat-strip"
import { makeTaskStatistics } from "@/lib/storybook/fixtures/scheduler"

// Horizontal stat carousel for the mobile scheduler page. Pure: `statistics`
// drives the four cards; the success-rate tile recolours by threshold. Renders
// null when `statistics` is null.
const meta = {
  title: "Mobile/Scheduler/MobileSchedulerStatStrip",
  component: MobileSchedulerStatStrip,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MobileSchedulerStatStrip>

export default meta
type Story = StoryObj<typeof meta>

/** Healthy fleet — high success rate (green). */
export const Healthy: Story = {
  args: { statistics: makeTaskStatistics() },
}

/** Degraded — sub-70% success rate (red). */
export const LowSuccess: Story = {
  args: {
    statistics: makeTaskStatistics({
      totalExecutions: 100,
      successfulExecutions: 55,
      failedExecutions: 45,
      activeTasks: 3,
      pausedTasks: 9,
    }),
  },
}
