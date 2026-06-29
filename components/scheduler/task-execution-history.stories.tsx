import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskExecutionHistory } from "./task-execution-history"
import { makeTaskExecution } from "@/lib/storybook/fixtures/scheduler"

// `TaskExecutionHistory` renders a scrollable list of execution rows with a
// status icon, locale-formatted timestamp, optional error/result/trigger
// provenance, and duration. Rows become clickable buttons when
// `onSelectExecution` is supplied; the list paginates in `maxItems` chunks via
// a "Load more" footer. Order is preserved as-is (no date filtering), so the
// deterministic fixture timestamps render directly.
const meta = {
  title: "Scheduler/TaskExecutionHistory",
  component: TaskExecutionHistory,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[460px] rounded-md border bg-card p-3">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskExecutionHistory>

export default meta
type Story = StoryObj<typeof meta>

// No executions → empty placeholder.
export const Empty: Story = {
  args: {
    executions: [],
  },
}

// A spread of every terminal/in-flight status.
export const MixedStatuses: Story = {
  args: {
    executions: [
      makeTaskExecution({ status: "completed" }),
      makeTaskExecution({ status: "failed" }),
      makeTaskExecution({ status: "running" }),
      makeTaskExecution({ status: "cancelled" }),
      makeTaskExecution({ status: "skipped" }),
      makeTaskExecution({ status: "pending" }),
    ],
  },
}

// Completed run carrying a result summary derived from `output`.
export const WithResultSummary: Story = {
  args: {
    executions: [
      makeTaskExecution({
        status: "completed",
        output: { summary: "Posted digest with 3 highlights to #standup." },
      }),
      makeTaskExecution({
        status: "failed",
        error: "Sidecar request timed out after 30s",
      }),
    ],
  },
}

// Non-default trigger source renders a provenance badge next to the timestamp.
export const ManualTrigger: Story = {
  args: {
    executions: [
      makeTaskExecution({ status: "completed", triggerSource: "run-now" }),
      makeTaskExecution({ status: "completed", triggerSource: "retry" }),
    ],
  },
}

// Rows become focusable buttons that fire `onSelectExecution`.
export const Clickable: Story = {
  args: {
    onSelectExecution: fn(),
    executions: [
      makeTaskExecution({ status: "completed" }),
      makeTaskExecution({ status: "failed" }),
      makeTaskExecution({ status: "completed" }),
    ],
  },
}

// More rows than `maxItems` → the "Load more" footer appears.
export const LoadMore: Story = {
  args: {
    maxItems: 5,
    executions: Array.from({ length: 14 }, (_, i) =>
      makeTaskExecution({ status: i % 3 === 0 ? "failed" : "completed" })
    ),
  },
}
