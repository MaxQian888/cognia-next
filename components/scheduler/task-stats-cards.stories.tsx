import type { Meta, StoryObj } from "@storybook/nextjs"

import { TaskStatsCards } from "./task-stats-cards"
import { makeScheduledTask, makeTaskExecution } from "@/lib/storybook/fixtures/scheduler"

// `TaskStatsCards` is a pure 4-up KPI grid for a single task. It derives the
// average duration from completed executions, so stories vary the execution
// mix to exercise the populated / no-completed-runs / no-next-run branches.
const meta = {
  title: "Scheduler/TaskStatsCards",
  component: TaskStatsCards,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TaskStatsCards>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    task: makeScheduledTask(),
    executions: [
      makeTaskExecution({ status: "completed", duration: 1_500 }),
      makeTaskExecution({ status: "completed", duration: 2_500 }),
      makeTaskExecution({ status: "failed" }),
    ],
  },
}

export const NoCompletedRuns: Story = {
  args: {
    task: makeScheduledTask({ successCount: 0, failureCount: 3 }),
    executions: [
      makeTaskExecution({ status: "failed" }),
      makeTaskExecution({ status: "running", duration: undefined }),
    ],
  },
}

export const NoNextRun: Story = {
  args: {
    task: makeScheduledTask({ status: "paused", nextRunAt: undefined }),
    executions: [makeTaskExecution({ status: "completed", duration: 900 })],
  },
}
