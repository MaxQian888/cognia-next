import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskDetailView } from "./task-detail-view"
import {
  makeScheduledTask,
  makeTaskExecution,
  makeCronTrigger,
} from "@/lib/storybook/fixtures/scheduler"

// `TaskDetailView` is a pure, props-only composite: it receives the task, its
// execution history, and a bag of action callbacks. The sub-cards it composes
// (stats / chart / history / configuration / notifications / tags) are all
// presentational, so realistic fixtures fully drive the surface.
const meta = {
  title: "Scheduler/TaskDetailView",
  component: TaskDetailView,
  parameters: { layout: "fullscreen" },
  args: {
    onPause: fn(),
    onResume: fn(),
    onRunNow: fn(),
    onDelete: fn(),
    onEdit: fn(),
    onSelectExecution: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskDetailView>

export default meta
type Story = StoryObj<typeof meta>

const mixedExecutions = [
  makeTaskExecution({ status: "completed" }),
  makeTaskExecution({ status: "completed" }),
  makeTaskExecution({ status: "failed" }),
  makeTaskExecution({ status: "running" }),
]

/** Active task with a healthy run history. */
export const Active: Story = {
  args: {
    task: makeScheduledTask({ status: "active" }),
    executions: mixedExecutions,
  },
}

/** Paused task — the pause control flips to a resume affordance. */
export const Paused: Story = {
  args: {
    task: makeScheduledTask({ status: "paused", name: "Weekly report (paused)" }),
    executions: mixedExecutions,
  },
}

/** A task whose recent runs are mostly failures, surfacing the error states. */
export const FailingRuns: Story = {
  args: {
    task: makeScheduledTask({
      status: "active",
      name: "Flaky ingest job",
      runCount: 20,
      successCount: 8,
      failureCount: 12,
      lastError: "Sidecar request timed out after 30s",
    }),
    executions: [
      makeTaskExecution({ status: "failed" }),
      makeTaskExecution({ status: "failed" }),
      makeTaskExecution({ status: "completed" }),
    ],
  },
}

/** Recurring (cron) task with backfill enabled — the More menu exposes backfill. */
export const WithBackfill: Story = {
  args: {
    task: makeScheduledTask({ status: "active", trigger: makeCronTrigger() }),
    executions: mixedExecutions,
    onBackfill: fn(),
  },
}

/** Task wired into a dependency neighborhood — renders the Dependencies card. */
export const WithDependencies: Story = {
  args: {
    task: makeScheduledTask({
      id: "focus",
      name: "Nightly rollup",
      trigger: makeCronTrigger({ dependsOn: ["upstream"] }),
    }),
    executions: mixedExecutions,
    allTasks: [
      makeScheduledTask({
        id: "focus",
        name: "Nightly rollup",
        trigger: makeCronTrigger({ dependsOn: ["upstream"] }),
      }),
      makeScheduledTask({ id: "upstream", name: "Extract raw events" }),
      makeScheduledTask({
        id: "downstream",
        name: "Publish digest",
        trigger: makeCronTrigger({ dependsOn: ["focus"] }),
      }),
    ],
    onSelectTask: fn(),
    onOpenDependencyGraph: fn(),
  },
}

/** Empty execution history — the chart and history degrade gracefully. */
export const NoExecutions: Story = {
  args: {
    task: makeScheduledTask({
      status: "active",
      name: "Just created",
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      lastRunAt: undefined,
    }),
    executions: [],
  },
}
