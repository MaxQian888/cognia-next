import type { Meta, StoryObj } from "@storybook/nextjs"

import { ScheduleCard } from "./schedule-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// Auto-backup schedule settings card. Reads the schedule + retention from the
// settings store (falls back to defaults). Folder picking is Tauri-only.
const meta = {
  title: "Data/ScheduleCard",
  component: ScheduleCard,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[28rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ScheduleCard>

export default meta
type Story = StoryObj<typeof meta>

// Defaults (no settings persisted).
export const Default: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
}

export const Enabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: {
        backupAutoSchedule: { enabled: true, intervalHours: 24, retain: 7 },
        backupReminderDays: 7,
      } as unknown as AppSettings,
    })
  },
}
