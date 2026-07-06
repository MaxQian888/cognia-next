import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerDashboardView } from "./scheduler-dashboard-view"
import type { ScheduledItemKind } from "@/types/scheduler/unified"
import {
  makeScheduledTask,
  makeTaskExecution,
  makeTaskStatistics,
} from "@/lib/storybook/fixtures/scheduler"

// `SchedulerDashboardView` is driven by props for its data (statistics,
// task slices, recent executions). The active view (overview/calendar/timeline)
// comes from `useSchedulerDashboardView`, which defaults to "overview" when the
// settings store is unseeded — so these stories render the overview. The
// embedded `ExecutionMonitorPanel` and unified-runs widgets read Dexie/the
// in-memory broker, both of which degrade to empty in Storybook (no Tauri).
const meta = {
  title: "Scheduler/SchedulerDashboardView",
  component: SchedulerDashboardView,
  parameters: { layout: "fullscreen" },
  args: {
    schedulerStatus: "running",
    onSelectTask: fn(),
  },
} satisfies Meta<typeof SchedulerDashboardView>

export default meta
type Story = StoryObj<typeof meta>

const activeTasks = [
  makeScheduledTask({ name: "Morning digest", status: "active" }),
  makeScheduledTask({ name: "Hourly inbox sync", status: "active" }),
]
const pausedTasks = [makeScheduledTask({ name: "Weekly report", status: "paused" })]
const upcomingTasks = [
  makeScheduledTask({ name: "Morning digest", status: "active" }),
  makeScheduledTask({ name: "Daily backup", status: "active" }),
  makeScheduledTask({ name: "Weekly report", status: "paused" }),
]
const recentExecutions = [
  makeTaskExecution({ taskName: "Morning digest", status: "completed" }),
  makeTaskExecution({ taskName: "Hourly inbox sync", status: "failed" }),
  makeTaskExecution({ taskName: "Daily backup", status: "completed" }),
]

const countsByKind: Record<ScheduledItemKind, number> = {
  app: 8,
  workflow: 3,
  backup: 1,
  plugin: 2,
  system: 4,
  connector: 2,
}
const activeCountsByKind: Record<ScheduledItemKind, number> = {
  app: 6,
  workflow: 2,
  backup: 1,
  plugin: 1,
  system: 4,
  connector: 1,
}

// Healthy dashboard: high success rate, populated stats + lists.
export const Populated: Story = {
  args: {
    statistics: makeTaskStatistics(),
    activeTasks,
    pausedTasks,
    upcomingTasks,
    recentExecutions,
    tasks: [...activeTasks, ...pausedTasks],
  },
}

// With the per-kind summary strip enabled.
export const WithKindSummary: Story = {
  args: {
    statistics: makeTaskStatistics(),
    activeTasks,
    pausedTasks,
    upcomingTasks,
    recentExecutions,
    countsByKind,
    activeCountsByKind,
    tasks: [...activeTasks, ...pausedTasks],
  },
}

// Low success rate → the success ring + value render in red.
export const HighFailureRate: Story = {
  args: {
    statistics: makeTaskStatistics({
      totalExecutions: 100,
      successfulExecutions: 55,
      failedExecutions: 45,
    }),
    activeTasks,
    pausedTasks,
    upcomingTasks,
    recentExecutions,
    tasks: [...activeTasks, ...pausedTasks],
  },
}

// No upcoming or recent rows → both bottom cards show their empty messages.
export const EmptyLists: Story = {
  args: {
    statistics: makeTaskStatistics({ upcomingExecutions: 0 }),
    activeTasks: [],
    pausedTasks: [],
    upcomingTasks: [],
    recentExecutions: [],
    tasks: [],
  },
}

// Null statistics → the overview body renders nothing (only the view toggle).
export const NoStatistics: Story = {
  args: {
    statistics: null,
    activeTasks: [],
    pausedTasks: [],
    upcomingTasks: [],
    recentExecutions: [],
    tasks: [],
  },
}
