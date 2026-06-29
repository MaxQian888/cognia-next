import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerUpcomingRail } from "./scheduler-upcoming-rail"
import { makeScheduledTask, makeTaskExecution } from "@/lib/storybook/fixtures/scheduler"

// `SchedulerUpcomingRail` is a props-only xl-only side rail listing the next
// upcoming runs and the most recent executions. Without an `onSelectRun`
// handler it renders purely from the `upcomingTasks` / `recentExecutions`
// props (the cross-kind unified hook path is opt-in and intentionally not
// exercised here). The rail is `xl:flex` / hidden below, so stories force it
// visible via a wide flex parent.
const meta = {
  title: "Scheduler/SchedulerUpcomingRail",
  component: SchedulerUpcomingRail,
  parameters: { layout: "fullscreen" },
  args: {
    onSelectTask: fn(),
  },
  decorators: [
    (Story) => (
      // Force the xl breakpoint container so the `xl:flex` rail is visible.
      <div className="flex h-[480px] w-[420px] justify-end bg-background xl:w-[420px]">
        <div className="flex">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerUpcomingRail>

export default meta
type Story = StoryObj<typeof meta>

const upcoming = [
  makeScheduledTask({ name: "Morning digest", status: "active" }),
  makeScheduledTask({ name: "Hourly inbox sync", status: "active" }),
  makeScheduledTask({ name: "Weekly report", status: "paused" }),
]

const recent = [
  makeTaskExecution({ taskName: "Morning digest", status: "completed" }),
  makeTaskExecution({ taskName: "Hourly inbox sync", status: "failed" }),
  makeTaskExecution({ taskName: "Nightly backup", status: "running" }),
]

export const Populated: Story = {
  args: {
    upcomingTasks: upcoming,
    recentExecutions: recent,
  },
}

export const Empty: Story = {
  args: {
    upcomingTasks: [],
    recentExecutions: [],
  },
}

export const OnlyUpcoming: Story = {
  args: {
    upcomingTasks: upcoming,
    recentExecutions: [],
  },
}

export const OnlyRecent: Story = {
  args: {
    upcomingTasks: [],
    recentExecutions: recent,
  },
}

// More than the 5-row cap on each section — the rail slices to the cap.
export const Overflowing: Story = {
  args: {
    upcomingTasks: Array.from({ length: 8 }, (_, i) =>
      makeScheduledTask({ name: `Upcoming task ${i + 1}`, status: "active" })
    ),
    recentExecutions: Array.from({ length: 8 }, (_, i) =>
      makeTaskExecution({ taskName: `Past run ${i + 1}`, status: "completed" })
    ),
  },
}
