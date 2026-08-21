import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SchedulerCalendarView } from "./scheduler-calendar-view"
import {
  makeUnifiedItem,
  makeUnifiedItemSet,
  FIXTURE_NOW,
} from "@/lib/storybook/fixtures/scheduler"

// `SchedulerCalendarView` is pure: it projects future runs of the supplied
// unified `items` onto a Monday-first month grid using
// `computeUnifiedOccurrences`, driven by an injectable `now`. We pin `now` to
// `FIXTURE_NOW` (2026-06-01T09:00:00Z, a Monday) so the density dots and
// selected-day panel are deterministic across renders.
const NOW = new Date(FIXTURE_NOW)

const meta = {
  title: "Scheduler/SchedulerCalendarView",
  component: SchedulerCalendarView,
  parameters: { layout: "padded" },
  args: {
    now: NOW,
    onSelectItem: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[560px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SchedulerCalendarView>

export default meta
type Story = StoryObj<typeof meta>

// Every source contributing runs → busy days with density dots, and a day
// panel whose rows are tinted by which subsystem scheduled them.
export const Populated: Story = {
  args: {
    items: makeUnifiedItemSet(),
  },
}

// A single hourly item — the collapsed-per-item row with a "+n" overflow.
export const SingleHourlyItem: Story = {
  args: {
    items: [
      makeUnifiedItem({
        kind: "app",
        name: "Hourly sync",
        status: "active",
        triggerSummary: { type: "cron", cron: "0 * * * *" },
      }),
    ],
  },
}

// No items → grid renders but every day is empty and the day panel shows the
// "no runs" message.
export const Empty: Story = {
  args: {
    items: [],
  },
}
