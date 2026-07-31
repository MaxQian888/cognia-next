import type { Meta, StoryObj } from "@storybook/nextjs"

import { BackupReminderBanner } from "./backup-reminder-banner"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// Soft "back up your data" nudge. Visibility comes from `shouldShowReminder`
// (settings.backupReminderDays + last successful backup + dismissedAt). The
// store is seeded with a reminder window and the (empty) Storybook DB has no
// backups, so it renders the "never backed up" copy.
const meta = {
  title: "Mobile/Me/BackupReminderBanner",
  component: BackupReminderBanner,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    useSettingsStore.setState({
      settings: { backupReminderDays: 7 } as unknown as AppSettings,
    })
  },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof BackupReminderBanner>

export default meta
type Story = StoryObj<typeof meta>

export const NeverBackedUp: Story = {}
