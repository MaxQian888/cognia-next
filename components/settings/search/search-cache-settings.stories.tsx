import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchCacheSettings } from "./search-cache-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeSearchAppSettings } from "@/lib/storybook/fixtures/settings-search"

// `SearchCacheSettings` reads cache prefs from `useSettingsStore` and live cache
// stats from the module-level `getSearchCache()` singleton (empty in Storybook).
// When the cache toggle is off the TTL / size / stats controls are hidden.
const meta = {
  title: "Settings/Search/SearchCacheSettings",
  component: SearchCacheSettings,
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
} satisfies Meta<typeof SearchCacheSettings>

export default meta
type Story = StoryObj<typeof meta>

// Cache enabled → TTL slider, max-entries slider, hit-rate panel and clear control.
export const Enabled: Story = {}

export const Disabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchCacheEnabled: false }),
    })
  },
}

export const LongTtlLargeCache: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchCacheTTL: 3_600_000,
        searchCacheMaxEntries: 2000,
      }),
    })
  },
}
