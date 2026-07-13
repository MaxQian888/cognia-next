import type { Meta, StoryObj } from "@storybook/nextjs"

import { NotificationPreferencesSection } from "./notification-preferences-section"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// Portable notification-preferences editor. Reads `settings.notificationPreferences`
// (resolved against defaults) and writes through `useSettingsPatch`. Stories show
// the default preferences and a quiet-hours-enabled variant.
const meta = {
  title: "Mobile/Me/NotificationPreferencesSection",
  component: NotificationPreferencesSection,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationPreferencesSection>

export default meta
type Story = StoryObj<typeof meta>

export const Defaults: Story = {}

export const QuietHoursEnabled: Story = {
  beforeEach: () => {
    useSettingsStore.setState({
      settings: {
        notificationPreferences: {
          quietHours: { enabled: true, start: "22:00", end: "07:00" },
        },
      } as unknown as AppSettings,
    })
  },
}
