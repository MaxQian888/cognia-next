import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerContentHeader } from "./scheduler-content-header"

// `SchedulerContentHeader` is a pure top bar: breadcrumb leaf, overflow menu,
// refresh button, and a split "New Task" button whose caret menu reveals
// per-kind create entries — but only for the optional callbacks that are
// supplied. Stories vary the breadcrumb, the refreshing state, and which
// per-kind create handlers are wired.
const meta = {
  title: "Scheduler/SchedulerContentHeader",
  component: SchedulerContentHeader,
  parameters: { layout: "fullscreen" },
  args: {
    onCreate: fn(),
    onRefresh: fn(),
    onExport: fn(),
    onImport: fn(),
    onOpenTemplates: fn(),
    onCleanup: fn(),
  },
} satisfies Meta<typeof SchedulerContentHeader>

export default meta
type Story = StoryObj<typeof meta>

// Default overview state — no task selected, all per-kind create handlers wired.
export const Overview: Story = {
  args: {
    selectedTaskName: null,
    onCreateSystemTask: fn(),
    onCreateWorkflowTrigger: fn(),
    onOpenBackupSettings: fn(),
    onOpenPluginSettings: fn(),
  },
}

// A task is selected — the breadcrumb leaf shows its name in foreground weight.
export const TaskSelected: Story = {
  args: {
    selectedTaskName: "Daily standup digest",
    onCreateSystemTask: fn(),
    onCreateWorkflowTrigger: fn(),
    onOpenBackupSettings: fn(),
    onOpenPluginSettings: fn(),
  },
}

// Long names truncate inside the flexible breadcrumb region.
export const LongTaskName: Story = {
  args: {
    selectedTaskName:
      "Nightly multi-region database backup, log rotation, and digest delivery to the on-call channel",
    onCreateSystemTask: fn(),
  },
}

// The refresh affordance spins while a refresh is in flight.
export const Refreshing: Story = {
  args: {
    selectedTaskName: null,
    isRefreshing: true,
  },
}

// Minimal wiring: only the primary "create app task" path exists, so the caret
// menu shows just the App-task entry.
export const AppTaskOnly: Story = {
  args: {
    selectedTaskName: null,
  },
}
