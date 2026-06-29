import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskExecutionChart } from "./task-execution-chart"
import { makeTaskExecution } from "@/lib/storybook/fixtures/scheduler"
import type { TaskExecution } from "@/types/scheduler"

// `TaskExecutionChart` buckets executions into the last 7 calendar days
// (relative to the real "now") and renders a stacked completed/failed/running
// bar chart. Because bucketing keys off the live date, these stories build
// executions with `startedAt` offsets relative to `Date.now()` so bars land in
// the visible window; the deterministic fixture timestamps would fall outside
// it and render the empty state.
const DAY = 24 * 60 * 60 * 1000

/** A completed execution `daysAgo` days before now, optionally re-shaped. */
function recent(daysAgo: number, over: Partial<TaskExecution> = {}): TaskExecution {
  return makeTaskExecution({
    startedAt: new Date(Date.now() - daysAgo * DAY),
    ...over,
  })
}

const meta = {
  title: "Scheduler/TaskExecutionChart",
  component: TaskExecutionChart,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskExecutionChart>

export default meta
type Story = StoryObj<typeof meta>

// No executions → empty-state card.
export const Empty: Story = {
  args: {
    executions: [],
  },
}

// All completed across the week.
export const AllSuccess: Story = {
  args: {
    executions: [recent(0), recent(1), recent(1), recent(2), recent(3), recent(5), recent(6)],
  },
}

// Mixed completed and failed runs.
export const MixedSuccessFailure: Story = {
  args: {
    executions: [
      recent(0),
      recent(0, { status: "failed" }),
      recent(1),
      recent(2, { status: "failed" }),
      recent(2),
      recent(4),
      recent(4, { status: "failed" }),
      recent(6),
    ],
  },
}

// Includes an in-flight run stacked on top.
export const WithRunning: Story = {
  args: {
    executions: [
      recent(0, { status: "running" }),
      recent(0),
      recent(1, { status: "failed" }),
      recent(1),
      recent(3),
      recent(3, { status: "running" }),
      recent(5),
    ],
  },
}

// `taskId` filters the dataset to a single task before bucketing.
export const FilteredByTask: Story = {
  args: {
    taskId: "task-A",
    executions: [
      recent(0, { taskId: "task-A" }),
      recent(1, { taskId: "task-A", status: "failed" }),
      recent(2, { taskId: "task-A" }),
      // Other task — excluded by the filter.
      recent(0, { taskId: "task-B" }),
      recent(1, { taskId: "task-B" }),
    ],
  },
}
