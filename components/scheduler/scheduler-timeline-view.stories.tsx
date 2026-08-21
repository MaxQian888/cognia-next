import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerTimelineView } from "./scheduler-timeline-view"
import {
  makeUnifiedItem,
  makeUnifiedItemSet,
  FIXTURE_NOW,
} from "@/lib/storybook/fixtures/scheduler"

// `SchedulerTimelineView` is pure: it projects the next `windowDays` of runs
// from the supplied unified `items` via `computeUnifiedOccurrences`, groups
// them by local day, and renders a day-headed agenda. `now` is pinned to
// `FIXTURE_NOW` (a Monday) so the "Today" / "Tomorrow" headers and row order
// are stable.
const NOW = new Date(FIXTURE_NOW)

const meta = {
  title: "Scheduler/SchedulerTimelineView",
  component: SchedulerTimelineView,
  parameters: { layout: "padded" },
  args: {
    now: NOW,
    onSelectItem: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[480px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerTimelineView>

export default meta
type Story = StoryObj<typeof meta>

// Every source across the default 14-day window → multiple day groups, each
// with a run count and a per-source accent on every row.
export const Populated: Story = {
  args: {
    items: makeUnifiedItemSet(),
  },
}

// A short 3-day window narrows the agenda to the next few days.
export const ShortWindow: Story = {
  args: {
    items: [
      makeUnifiedItem({
        kind: "app",
        name: "Weekday digest",
        status: "active",
        triggerSummary: { type: "cron", cron: "0 9 * * 1-5" },
      }),
      makeUnifiedItem({
        kind: "backup",
        name: "Daily backup",
        status: "active",
        triggerSummary: { type: "cron", cron: "0 2 * * *" },
      }),
    ],
    windowDays: 3,
  },
}

// No projected runs → the empty agenda state.
export const Empty: Story = {
  args: {
    items: [],
  },
}
