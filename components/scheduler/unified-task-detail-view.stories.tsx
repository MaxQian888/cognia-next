import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { UnifiedTaskDetailView } from "./unified-task-detail-view"
import {
  makeScheduledTask,
  makeTaskExecution,
  makeUnifiedItem,
} from "@/lib/storybook/fixtures/scheduler"

// `UnifiedTaskDetailView` dispatches on `item.kind`. For `app` it delegates to
// `TaskDetailView` (fully driven by `appTaskDetail`). For every other kind it
// renders the shared `DetailHeader` plus a per-kind body; those bodies read
// Dexie / system-scheduler hooks that simply resolve empty outside Tauri, so
// they degrade to their "not found" / "no recent runs" states — no crash.
const meta = {
  title: "Scheduler/UnifiedTaskDetailView",
  component: UnifiedTaskDetailView,
  parameters: { layout: "fullscreen" },
  args: {
    onRunNow: fn(),
    onPause: fn(),
    onResume: fn(),
    onEdit: fn(),
    onDelete: fn(),
    onSelectRun: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-[760px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof UnifiedTaskDetailView>

export default meta
type Story = StoryObj<typeof meta>

/** `app` kind — defers entirely to the rich `TaskDetailView`. */
export const AppKind: Story = {
  args: {
    item: makeUnifiedItem({ kind: "app", name: "Overnight digest" }),
    appTaskDetail: {
      task: makeScheduledTask({ status: "active" }),
      executions: [
        makeTaskExecution({ status: "completed" }),
        makeTaskExecution({ status: "failed" }),
      ],
      onPause: fn(),
      onResume: fn(),
      onRunNow: fn(),
      onDelete: fn(),
      onEdit: fn(),
    },
  },
}

/** `workflow` kind — header + workflow body (resolves to empty without Dexie). */
export const WorkflowKind: Story = {
  args: {
    item: makeUnifiedItem({ kind: "workflow", name: "Nightly ETL workflow" }),
  },
}

/** `backup` kind — limited capabilities (delete disabled). */
export const BackupKind: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "backup",
      name: "Weekly full backup",
      status: "paused",
      capabilities: { runNow: true, pause: true, edit: true, delete: false },
    }),
  },
}

/** `connector` kind — digest detail body. */
export const ConnectorKind: Story = {
  args: {
    item: makeUnifiedItem({ kind: "connector", name: "Slack daily summary" }),
  },
}

/** `system` kind — read-only inspector body (empty outside Tauri). */
export const SystemKind: Story = {
  args: {
    item: makeUnifiedItem({
      kind: "system",
      name: "OS health check",
      status: "active",
      capabilities: { runNow: false, pause: false, edit: false, delete: true },
    }),
  },
}
