import type { Meta, StoryObj } from "@storybook/nextjs"

import { ReminderBanner } from "./reminder-banner"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { seedDb } from "@/lib/storybook/seed-db"
import type { AppSettings } from "@cognia/agent-config-types"

// Soft "back up your data" reminder. Visible only when `backupReminderDays` is
// set and the last successful backup (Dexie `backupHistory`) is older than that
// window (or there is none). Seed the settings store to control visibility.
const meta = {
  title: "Data/ReminderBanner",
  component: ReminderBanner,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ReminderBanner>

export default meta
type Story = StoryObj<typeof meta>

// Reminder enabled + no prior backup → "never backed up" copy.
export const NeverBackedUp: Story = {
  beforeEach: async () => {
    resetStore(useSettingsStore)
    await seedDb(async () => {})
    seedStore(useSettingsStore, { settings: { backupReminderDays: 7 } as AppSettings })
  },
}

// No reminder configured → renders nothing.
export const Hidden: Story = {
  beforeEach: async () => {
    resetStore(useSettingsStore)
    await seedDb(async () => {})
  },
  render: () => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when no reminder is due → <ReminderBanner />
    </div>
  ),
}
