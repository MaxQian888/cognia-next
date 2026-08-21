import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskExecutionChart, type ExecutionChartPoint } from "./task-execution-chart"

// `TaskExecutionChart` buckets already-normalized points into the last 7
// calendar days (relative to the real "now") and renders a stacked
// completed/failed/running bar chart. Because bucketing keys off the live date,
// these stories build points with `startedAt` offsets relative to `Date.now()`
// so bars land in the visible window; deterministic fixture timestamps would
// fall outside it and render the empty state.
const DAY = 24 * 60 * 60 * 1000

/** A point `daysAgo` days before now. */
function recent(
  daysAgo: number,
  outcome: ExecutionChartPoint["outcome"] = "completed"
): ExecutionChartPoint {
  return { startedAt: Date.now() - daysAgo * DAY, outcome }
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

// No points → empty-state card.
export const Empty: Story = {
  args: {
    runs: [],
  },
}

// All completed across the week.
export const AllSuccess: Story = {
  args: {
    runs: [recent(0), recent(1), recent(1), recent(2), recent(3), recent(5), recent(6)],
  },
}

// Mixed completed and failed runs.
export const MixedSuccessFailure: Story = {
  args: {
    runs: [
      recent(0),
      recent(0, "failed"),
      recent(1),
      recent(2, "failed"),
      recent(2),
      recent(4),
      recent(4, "failed"),
      recent(6),
    ],
  },
}

// Includes an in-flight run stacked on top.
export const WithRunning: Story = {
  args: {
    runs: [
      recent(0, "running"),
      recent(0),
      recent(1, "failed"),
      recent(1),
      recent(3),
      recent(3, "running"),
      recent(5),
    ],
  },
}
