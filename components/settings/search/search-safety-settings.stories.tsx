import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchSafetySettings } from "./search-safety-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeSearchAppSettings } from "@/lib/storybook/fixtures/settings-search"

// `SearchSafetySettings` toggles SafeSearch and, when on, exposes the level as a
// card-style segmented control (off / moderate / strict). Reads the two values
// from `useSettingsStore`.
const meta = {
  title: "Settings/Search/SearchSafetySettings",
  component: SearchSafetySettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchSafetySettings>

export default meta
type Story = StoryObj<typeof meta>

// Enabled + moderate (the default).
export const ModerateLevel: Story = {}

export const StrictLevel: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchSafeSearchLevel: "strict" }),
    })
  },
}

// Disabled → the level control is hidden.
export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchSafeSearchEnabled: false }),
    })
  },
}
