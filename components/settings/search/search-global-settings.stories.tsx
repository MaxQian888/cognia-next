import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SearchGlobalSettings } from "./search-global-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makeConfiguredProviders,
} from "@/lib/storybook/fixtures/settings-search"

// `SearchGlobalSettings` is the "basics" panel: the master enable toggle,
// default provider, max results, fallback, and the research-source picker. When
// no provider is configured+enabled it surfaces a "configure providers" alert.
const meta = {
  title: "Settings/Search/SearchGlobalSettings",
  component: SearchGlobalSettings,
  parameters: { layout: "padded" },
  args: { onConfigureProviders: fn() },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchEnabled: false }),
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchGlobalSettings>

export default meta
type Story = StoryObj<typeof meta>

// No usable provider → the warning alert with a "Providers" jump button shows.
export const NoProvider: Story = {}

// Search enabled with two configured providers → no alert, provider select and
// source picker are interactive.
export const EnabledWithProviders: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchEnabled: true,
        defaultSearchProvider: "tavily",
        defaultSearchSources: ["wikipedia", "arxiv"],
        searchProviders: makeConfiguredProviders(),
      }),
    })
  },
}

// Enabled but still no configured provider — toggles are on yet the alert and a
// disabled provider select remain.
export const EnabledNoProvider: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchEnabled: true }),
    })
  },
}
