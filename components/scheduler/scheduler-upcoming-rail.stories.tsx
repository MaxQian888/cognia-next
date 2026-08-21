import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerUpcomingRail } from "./scheduler-upcoming-rail"
import {
  makeUnifiedItem,
  makeUnifiedRun,
  makeUnifiedRunSet,
  FIXTURE_NOW,
} from "@/lib/storybook/fixtures/scheduler"

// `SchedulerUpcomingRail` is a props-only xl-only side rail listing the next
// upcoming runs and the most recent runs, both cross-source. `now` is pinned to
// `FIXTURE_NOW` so the relative timestamps stay stable. The rail is `xl:flex` /
// hidden below, so stories force it visible via a wide flex parent.
const NOW = FIXTURE_NOW
const MINUTE = 60_000

const meta = {
  title: "Scheduler/SchedulerUpcomingRail",
  component: SchedulerUpcomingRail,
  parameters: { layout: "fullscreen" },
  args: {
    now: NOW,
    onSelectItem: fn(),
    onSelectRun: fn(),
  },
  decorators: [
    (Story) => (
      // Force the xl breakpoint container so the `xl:flex` rail is visible.
      <div className="flex h-[480px] w-[420px] justify-end bg-background xl:w-[420px]">
        <div className="flex">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerUpcomingRail>

export default meta
type Story = StoryObj<typeof meta>

const upcoming = [
  makeUnifiedItem({ kind: "app", name: "Morning digest", nextRunAt: NOW + 5 * MINUTE }),
  makeUnifiedItem({ kind: "workflow", name: "Nightly ETL", nextRunAt: NOW + 30 * MINUTE }),
  makeUnifiedItem({ kind: "backup", name: "Weekly full backup", nextRunAt: NOW + 90 * MINUTE }),
]

const recent = makeUnifiedRunSet()

export const Populated: Story = {
  args: {
    items: upcoming,
    recentRuns: recent,
  },
}

export const Empty: Story = {
  args: {
    items: [],
    recentRuns: [],
  },
}

export const OnlyUpcoming: Story = {
  args: {
    items: upcoming,
    recentRuns: [],
  },
}

export const OnlyRecent: Story = {
  args: {
    items: [],
    recentRuns: recent,
  },
}

// More than the 5-row cap on each section — the rail slices to the cap.
export const Overflowing: Story = {
  args: {
    items: Array.from({ length: 8 }, (_, i) =>
      makeUnifiedItem({ name: `Upcoming item ${i + 1}`, nextRunAt: NOW + (i + 1) * MINUTE })
    ),
    recentRuns: Array.from({ length: 8 }, (_, i) =>
      makeUnifiedRun({ itemName: `Past run ${i + 1}`, status: "succeeded" })
    ),
  },
}
