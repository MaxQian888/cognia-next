import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerSidebarContent } from "./scheduler-sidebar"
import {
  makeScheduledTask,
  makeSystemTask,
  makeTaskStatistics,
  makeUnifiedItemSet,
} from "@/lib/storybook/fixtures/scheduler"
import type { ScheduledItemKind } from "@/types/scheduler/unified"

// `SchedulerSidebarContent` is the provider-free content variant rendered inside
// the desktop resizable panel (the `<Sidebar>` chrome wrapper needs a
// SidebarProvider; the content sections do not). It is fully props-driven.
const meta = {
  title: "Scheduler/SchedulerSidebar",
  component: SchedulerSidebarContent,
  parameters: { layout: "fullscreen" },
  args: {
    schedulerStatus: "running",
    searchQuery: "",
    activeFilter: "all",
    selectedTaskId: null,
    onSearchChange: fn(),
    onFilterChange: fn(),
    onSelectTask: fn(),
    onSelectSystemTask: fn(),
    onRunNow: fn(),
    onPause: fn(),
    onResume: fn(),
    onDelete: fn(),
    onCreate: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[760px] w-[320px] flex-col bg-sidebar text-sidebar-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerSidebarContent>

export default meta
type Story = StoryObj<typeof meta>

const appTasks = [
  makeScheduledTask({ id: "a1", name: "Overnight digest", status: "active" }),
  makeScheduledTask({ id: "a2", name: "Weekly report", status: "paused" }),
  makeScheduledTask({ id: "a3", name: "Loop poll", status: "active", tags: ["loop"] }),
]

const unifiedItems = makeUnifiedItemSet()
const countsByKind = unifiedItems.reduce(
  (acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1
    return acc
  },
  { app: 0, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 } as Record<
    ScheduledItemKind,
    number
  >
)

/** Legacy app + system split (no unified items supplied). */
export const Legacy: Story = {
  args: {
    tasks: appTasks,
    systemTasks: [makeSystemTask()],
    statistics: makeTaskStatistics(),
    activeCount: 2,
    pausedCount: 1,
  },
}

/** Unified view — items grouped into collapsible per-kind sections. */
export const Unified: Story = {
  args: {
    tasks: appTasks,
    systemTasks: [makeSystemTask()],
    unifiedItems,
    countsByKind,
    statistics: makeTaskStatistics(),
    activeCount: 2,
    pausedCount: 1,
    selectedTaskId: "src-1",
    onSelectUnifiedItem: fn(),
    onUnifiedRunNow: fn(),
    onUnifiedPause: fn(),
    onUnifiedResume: fn(),
    onUnifiedDelete: fn(),
    selectedUnifiedIds: [],
    onToggleUnifiedSelection: fn(),
  },
}

/** Stopped scheduler — the status dot turns red. */
export const Stopped: Story = {
  args: {
    tasks: appTasks,
    systemTasks: [],
    schedulerStatus: "stopped",
    statistics: makeTaskStatistics({ totalExecutions: 0, successfulExecutions: 0 }),
    activeCount: 2,
    pausedCount: 1,
  },
}

/** Empty unified state — the create CTA is shown. */
export const Empty: Story = {
  args: {
    tasks: [],
    systemTasks: [],
    unifiedItems: [],
    countsByKind: { app: 0, workflow: 0, backup: 0, plugin: 0, system: 0, connector: 0 },
    statistics: makeTaskStatistics({ totalTasks: 0, activeTasks: 0, totalExecutions: 0 }),
    activeCount: 0,
    pausedCount: 0,
  },
}
