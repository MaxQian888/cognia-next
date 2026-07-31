import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProfileSection } from "./profile-section"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// User profile editor (dual-mounted on desktop settings + mobile /me/profile).
// Reads `settings.profile` + the `loaded` flag from the settings store via
// `useUserProfile`. Until the store hydrates the section shows a skeleton, so
// every story seeds `loaded: true`.
const meta = {
  title: "Settings/Profile/ProfileSection",
  component: ProfileSection,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings({ profile: {} }) })
  },
} satisfies Meta<typeof ProfileSection>

export default meta
type Story = StoryObj<typeof meta>

// Empty profile → placeholder fields, no reset button.
export const Empty: Story = {}

// A fully-filled profile → fields populated, bio counter advanced, reset shown.
export const Filled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({
        profile: {
          displayName: "Ada Lovelace",
          pronouns: "she/her",
          statusMessage: "Shipping the analytical engine",
          bio: "Mathematician and the first computer programmer.",
          updatedAt: Date.now(),
        },
      }),
    })
  },
}
