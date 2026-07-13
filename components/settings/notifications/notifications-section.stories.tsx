import type { Meta, StoryObj } from "@storybook/nextjs"

import { NotificationsSection } from "./notifications-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// `NotificationsSection` resolves `notificationPreferences` through
// `resolvePreferences` (so an empty store still renders the full default
// preference set): OS permission, default channels, per-level gates,
// quiet-hours, per-source mute, behaviour toggles, and retention sliders.
function seedSettings(patch: Partial<AppSettings>) {
  return () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: patch as unknown as AppSettings })
  }
}

const meta = {
  title: "Settings/Notifications/NotificationsSection",
  component: NotificationsSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationsSection>

export default meta
type Story = StoryObj<typeof meta>

// Default resolved preferences (no stored overrides).
export const Default: Story = {}

// Quiet hours enabled — reveals the start/end time inputs.
export const QuietHoursEnabled: Story = {
  beforeEach: seedSettings({
    notificationPreferences: {
      quietHours: { enabled: true, start: "22:00", end: "07:30" },
    },
  } as unknown as Partial<AppSettings>),
}
