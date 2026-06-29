import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn, userEvent, within } from "storybook/test"

import { BackupScheduleDialog } from "./backup-schedule-dialog"
import { Button } from "@/components/ui/button"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"

// `BackupScheduleDialog` creates a cron-driven `backup` ScheduledTask via the
// scheduler store (`useScheduler` → `useSchedulerStore`). It owns its own open
// state behind a trigger (no `open` prop), so the primary stories use a `play`
// step to click the trigger and reveal the form. We seed `isInitialized: true`
// so the store's mount-time initialize effect is a no-op in Storybook.
const meta = {
  title: "Scheduler/BackupScheduleDialog",
  component: BackupScheduleDialog,
  parameters: { layout: "centered" },
  args: {
    onScheduled: fn(),
  },
  beforeEach: () => {
    resetStore(useSchedulerStore)
    seedStore(useSchedulerStore, { isInitialized: true })
  },
} satisfies Meta<typeof BackupScheduleDialog>

export default meta
type Story = StoryObj<typeof meta>

// Default trigger button; the play step opens the dialog so the cron schedule,
// backup type, destination, and include-options are visible.
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button"))
  },
}

// A custom trigger node replaces the default outline button.
export const CustomTrigger: Story = {
  args: {
    trigger: <Button variant="default">Configure scheduled backup</Button>,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button"))
  },
}

// The closed trigger on its own (no auto-open), showing the default entry
// point as it appears inline in settings.
export const TriggerOnly: Story = {}
