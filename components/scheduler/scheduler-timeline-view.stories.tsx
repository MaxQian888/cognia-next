import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerTimelineView } from "./scheduler-timeline-view"
import { makeScheduledTask, makeCronTrigger, FIXTURE_NOW } from "@/lib/storybook/fixtures/scheduler"

// `SchedulerTimelineView` is pure: it projects the next `windowDays` of runs
// from the supplied `tasks` via `computeUpcomingOccurrences`, groups them by
// local day, and renders a day-headed agenda. `now` is pinned to `FIXTURE_NOW`
// (a Monday) so the "Today" / "Tomorrow" headers and row order are stable.
const NOW = new Date(FIXTURE_NOW)

const meta = {
  title: "Scheduler/SchedulerTimelineView",
  component: SchedulerTimelineView,
  parameters: { layout: "padded" },
  args: {
    now: NOW,
    onSelectTask: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerTimelineView>

export default meta
type Story = StoryObj<typeof meta>

// Several tasks across the default 14-day window → multiple day groups, each
// with a run count and trigger-type badge per row.
export const Populated: Story = {
  args: {
    tasks: [
      makeScheduledTask({ name: "Weekday digest", status: "active" }),
      makeScheduledTask({
        name: "Hourly sync",
        status: "active",
        trigger: makeCronTrigger({ cronExpression: "0 * * * *" }),
      }),
      makeScheduledTask({
        name: "Daily backup",
        status: "active",
        trigger: makeCronTrigger({ cronExpression: "0 2 * * *" }),
      }),
    ],
  },
}

// A short 3-day window narrows the agenda to the next few days.
export const ShortWindow: Story = {
  args: {
    tasks: [
      makeScheduledTask({ name: "Weekday digest", status: "active" }),
      makeScheduledTask({
        name: "Daily backup",
        status: "active",
        trigger: makeCronTrigger({ cronExpression: "0 2 * * *" }),
      }),
    ],
    windowDays: 3,
  },
}

// No projected runs → the empty agenda state.
export const Empty: Story = {
  args: {
    tasks: [],
  },
}
