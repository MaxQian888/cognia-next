import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { BackfillDialog } from "./backfill-dialog"
import { makeScheduledTask, makeCronTrigger, FIXTURE_NOW } from "@/lib/storybook/fixtures/scheduler"

// `BackfillDialog` is a pure, props-only modal: it re-runs the past schedule
// slots of a recurring task over a [start, end] range. It starts with empty
// date/time fields (slot preview appears once a valid past range is entered)
// and surfaces a validation message immediately when the task can't be
// backfilled (non-recurring trigger or missing task). Rendered `open` so the
// form is visible; `onBackfill` is a spy resolving with a slot count.
const meta = {
  title: "Scheduler/BackfillDialog",
  component: BackfillDialog,
  parameters: { layout: "centered" },
  args: {
    open: true,
    onOpenChange: fn(),
    onBackfill: fn(async () => 12),
  },
} satisfies Meta<typeof BackfillDialog>

export default meta
type Story = StoryObj<typeof meta>

// A daily cron task — backfill is supported, so the form renders with no
// validation error and waits for a date range.
export const CronTask: Story = {
  args: {
    task: makeScheduledTask({
      name: "Daily standup digest",
      trigger: makeCronTrigger({ cronExpression: "0 9 * * 1-5" }),
    }),
  },
}

// An interval task is also recurring and therefore backfillable.
export const IntervalTask: Story = {
  args: {
    task: makeScheduledTask({
      name: "Inbox sweep (every 30m)",
      trigger: { type: "interval", intervalMs: 30 * 60_000, timezone: "UTC" },
    }),
  },
}

// A one-time task can't be backfilled — the dialog shows the
// "unsupported trigger" validation message up front.
export const UnsupportedOnceTask: Story = {
  args: {
    task: makeScheduledTask({
      name: "One-off launch reminder",
      trigger: { type: "once", runAt: new Date(FIXTURE_NOW + 86_400_000) },
    }),
  },
}

// No task selected — also surfaces the unsupported-trigger guard.
export const NoTask: Story = {
  args: {
    task: null,
  },
}
