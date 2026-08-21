import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerDashboardView } from "./scheduler-dashboard-view"
import { deriveUnifiedStatistics } from "@/lib/scheduler/unified-filter"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import {
  makeUnifiedItem,
  makeUnifiedItemSet,
  makeUnifiedRun,
  makeUnifiedRunSet,
  FIXTURE_NOW,
} from "@/lib/storybook/fixtures/scheduler"

// `SchedulerDashboardView` is driven entirely by the merged cross-source list:
// its headline statistics are derived from the same `items` its calendar and
// agenda project, so the numbers can never disagree with the rows. The active
// view (overview/calendar/timeline) comes from `useSchedulerDashboardView`,
// which defaults to "overview" when the settings store is unseeded — so these
// stories render the overview. The embedded `ExecutionMonitorPanel` and
// unified-runs widgets read Dexie / the in-memory broker, both of which degrade
// to empty in Storybook (no Tauri).
const NOW = FIXTURE_NOW
const MINUTE = 60_000

/** Statistics always come from the very items being rendered. */
function storyArgs(items: UnifiedScheduledItem[], runs = makeUnifiedRunSet()) {
  return { items, statistics: deriveUnifiedStatistics(items), recentRuns: runs }
}

const meta = {
  title: "Scheduler/SchedulerDashboardView",
  component: SchedulerDashboardView,
  parameters: { layout: "fullscreen" },
  args: {
    now: NOW,
    onSelectItem: fn(),
    onSelectRun: fn(),
    onSelectKind: fn(),
  },
} satisfies Meta<typeof SchedulerDashboardView>

export default meta
type Story = StoryObj<typeof meta>

const populated: UnifiedScheduledItem[] = [
  makeUnifiedItem({
    kind: "app",
    name: "Morning digest",
    nextRunAt: NOW + 5 * MINUTE,
    successCount: 318,
    failureCount: 22,
  }),
  makeUnifiedItem({ kind: "workflow", name: "Nightly ETL", nextRunAt: NOW + 45 * MINUTE }),
  makeUnifiedItem({ kind: "backup", name: "Weekly full backup", status: "paused" }),
  makeUnifiedItem({ kind: "connector", name: "Slack summary", nextRunAt: NOW + 90 * MINUTE }),
]

// Healthy dashboard: high success rate, populated lists across four sources.
export const Populated: Story = {
  args: storyArgs(populated),
}

// Every source represented — the kind rail lights up across the board.
export const EverySource: Story = {
  args: storyArgs(makeUnifiedItemSet()),
}

// A kind pinned in the sidebar filter — the rail marks it as pressed.
export const KindPinned: Story = {
  args: {
    ...storyArgs(populated),
    selectedKinds: new Set<ScheduledItemKind>(["workflow"]),
  },
}

// Low success rate → the value and its meter render in red.
export const HighFailureRate: Story = {
  args: storyArgs([
    makeUnifiedItem({
      kind: "app",
      name: "Flaky sync",
      nextRunAt: NOW + 5 * MINUTE,
      successCount: 55,
      failureCount: 45,
    }),
  ]),
}

// Nothing has ever run → the rate reads "—" rather than a red 0%.
export const NoRunsYet: Story = {
  args: storyArgs(
    [
      makeUnifiedItem({
        kind: "app",
        name: "Fresh task",
        nextRunAt: NOW + 5 * MINUTE,
        successCount: undefined,
        failureCount: undefined,
      }),
    ],
    []
  ),
}

// Nothing scheduled at all → the upcoming block shows its empty message.
export const EmptyLists: Story = {
  args: storyArgs([], [makeUnifiedRun({ status: "cancelled" })]),
}
