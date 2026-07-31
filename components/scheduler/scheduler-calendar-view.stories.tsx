import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerCalendarView } from "./scheduler-calendar-view"
import { makeScheduledTask, makeCronTrigger, FIXTURE_NOW } from "@/lib/storybook/fixtures/scheduler"

// `SchedulerCalendarView` is pure: it projects future runs of the supplied
// `tasks` onto a Monday-first month grid using `computeUpcomingOccurrences`,
// driven by an injectable `now`. We pin `now` to `FIXTURE_NOW`
// (2026-06-01T09:00:00Z, a Monday) so the density dots and selected-day panel
// are deterministic across renders.
const NOW = new Date(FIXTURE_NOW)

const meta = {
  title: "Scheduler/SchedulerCalendarView",
  component: SchedulerCalendarView,
  parameters: { layout: "padded" },
  args: {
    now: NOW,
    onSelectTask: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerCalendarView>

export default meta
type Story = StoryObj<typeof meta>

// A weekday-cron task plus an hourly and a daily task → busy days with density
// dots; selecting "today" reveals that day's runs.
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

// Single weekday task — sparser grid, at most one dot per weekday.
export const SingleTask: Story = {
  args: {
    tasks: [makeScheduledTask({ name: "Weekday digest", status: "active" })],
  },
}

// No tasks → grid renders but every day is empty and the day panel shows the
// "no runs" message.
export const Empty: Story = {
  args: {
    tasks: [],
  },
}
