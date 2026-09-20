import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchReliabilitySettings } from "./search-reliability-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeSearchAppSettings } from "@/lib/storybook/fixtures/settings-search"

// `SearchReliabilitySettings` reads `settings.searchProviderHealth` (falling
// back to the library defaults) and writes through
// `setSearchProviderHealthSettings`. When the breaker is off the sliders hide.
const meta = {
  title: "Settings/Search/SearchReliabilitySettings",
  component: SearchReliabilitySettings,
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
} satisfies Meta<typeof SearchReliabilitySettings>

export default meta
type Story = StoryObj<typeof meta>

// Breaker enabled at the defaults: threshold 3, cooldown 30s.
export const Enabled: Story = {}

export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviderHealth: { enabled: false, failureThreshold: 3, cooldownMs: 30_000 },
      }),
    })
  },
}

export const SensitiveBreaker: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviderHealth: { enabled: true, failureThreshold: 1, cooldownMs: 600_000 },
      }),
    })
  },
}
