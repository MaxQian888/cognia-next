import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerMobileDetailView } from "./scheduler-mobile-detail"
import {
  makeScheduledTask,
  makeTaskExecution,
  makeUnifiedItem,
} from "@/lib/storybook/fixtures/scheduler"

// Full-screen mobile detail. Two modes: the rich `app` path (task + executions)
// and the `unified` path which delegates the body to `UnifiedTaskDetailView`.
// All data arrives via props; callbacks are spies.
const meta = {
  title: "Scheduler/SchedulerMobileDetailView",
  component: SchedulerMobileDetailView,
  parameters: { layout: "fullscreen" },
  args: {
    onBack: fn(),
    onPause: fn(),
    onResume: fn(),
    onRunNow: fn(),
    onDelete: fn(),
    onEdit: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-[420px] border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerMobileDetailView>

export default meta
type Story = StoryObj<typeof meta>

const executions = [
  makeTaskExecution({ status: "completed" }),
  makeTaskExecution({ status: "failed" }),
  makeTaskExecution({ status: "running" }),
]

/** App-kind mobile detail with the full stats / chart / history stack. */
export const AppActive: Story = {
  args: {
    task: makeScheduledTask({ status: "active" }),
    executions,
    onSelectRun: fn(),
  },
}

/** Paused app task — the More menu offers Resume. */
export const AppPaused: Story = {
  args: {
    task: makeScheduledTask({ status: "paused", name: "Weekly report (paused)" }),
    executions,
  },
}

/** Unified (workflow) path — header + orchestrator body. */
export const UnifiedWorkflow: Story = {
  args: {
    unifiedItem: makeUnifiedItem({ kind: "workflow", name: "Nightly ETL workflow" }),
    onUnifiedRunNow: fn(),
    onUnifiedPause: fn(),
    onUnifiedResume: fn(),
    onUnifiedDelete: fn(),
    onSelectRun: fn(),
  },
}

/** Unified (connector) path. */
export const UnifiedConnector: Story = {
  args: {
    unifiedItem: makeUnifiedItem({ kind: "connector", name: "Slack daily summary" }),
    onUnifiedRunNow: fn(),
    onUnifiedDelete: fn(),
    onSelectRun: fn(),
  },
}
