import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskSidebarItem } from "./task-sidebar-item"
import { makeScheduledTask } from "@/lib/storybook/fixtures/scheduler"

// `TaskSidebarItem` is a pure, props-only sidebar row: it takes a single
// `ScheduledTask`, a selected flag, and a set of optional action callbacks that
// populate the right-click dropdown menu. Stories vary the task status, type,
// and which actions are wired so every visual branch is covered.
const meta = {
  title: "Scheduler/TaskSidebarItem",
  component: TaskSidebarItem,
  parameters: { layout: "centered" },
  args: {
    onClick: fn(),
    onRunNow: fn(),
    onPause: fn(),
    onResume: fn(),
    onEdit: fn(),
    onDuplicate: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-72 rounded-md border bg-background">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskSidebarItem>

export default meta
type Story = StoryObj<typeof meta>

export const Active: Story = {
  args: {
    task: makeScheduledTask({ name: "Daily standup digest", status: "active" }),
    isActive: false,
  },
}

export const Selected: Story = {
  args: {
    task: makeScheduledTask({ name: "Daily standup digest", status: "active" }),
    isActive: true,
  },
}

export const Highlighted: Story = {
  args: {
    task: makeScheduledTask({ name: "Recently jumped-to task", status: "active" }),
    isActive: false,
    isHighlighted: true,
  },
}

export const Paused: Story = {
  args: {
    task: makeScheduledTask({ name: "Weekly report (paused)", status: "paused" }),
    isActive: false,
  },
}

export const Disabled: Story = {
  args: {
    task: makeScheduledTask({ name: "Disabled cleanup job", status: "disabled" }),
    isActive: false,
  },
}

export const Expired: Story = {
  args: {
    task: makeScheduledTask({ name: "One-off launch reminder", status: "expired" }),
    isActive: false,
  },
}

export const WorkflowType: Story = {
  args: {
    task: makeScheduledTask({ name: "Nightly ETL workflow", type: "workflow" }),
    isActive: false,
  },
}

export const AgentType: Story = {
  args: {
    task: makeScheduledTask({ name: "Research agent run", type: "agent" }),
    isActive: false,
  },
}

export const IntervalTrigger: Story = {
  args: {
    task: makeScheduledTask({
      name: "Inbox sweep (every 15m)",
      trigger: { type: "interval", intervalMs: 15 * 60_000, timezone: "UTC" },
    }),
    isActive: false,
  },
}

export const NoActions: Story = {
  args: {
    task: makeScheduledTask({ name: "Read-only item" }),
    isActive: false,
    onRunNow: undefined,
    onPause: undefined,
    onResume: undefined,
    onEdit: undefined,
    onDuplicate: undefined,
    onDelete: undefined,
  },
}
