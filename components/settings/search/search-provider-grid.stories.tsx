import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchProviderGrid } from "./search-provider-grid"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makeProviders,
  makeConfiguredProviders,
} from "@/lib/storybook/fixtures/settings-search"

// `SearchProviderGrid` lists every provider as a `SearchProviderCard`, with a
// name filter, a feature filter dropdown, and bulk enable/disable/reset actions.
// Configured providers float to the top. Reads provider settings from the store.
const meta = {
  title: "Settings/Search/SearchProviderGrid",
  component: SearchProviderGrid,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchProviderGrid>

export default meta
type Story = StoryObj<typeof meta>

// No provider configured → full catalogue in base order.
export const AllUnconfigured: Story = {}

// Tavily + Brave configured → both float to the top of the grid.
export const SomeConfigured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchProviders: makeConfiguredProviders() }),
    })
  },
}

// A provider configured but with an unverified key (no enable yet).
export const ConfiguredKeyNotEnabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchProviders: makeProviders({
          exa: { apiKey: "exa-demo-key-1234567890", enabled: false },
        }),
      }),
    })
  },
}
