import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchSettings } from "./search-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makeConfiguredProviders,
} from "@/lib/storybook/fixtures/settings-search"

// `SearchSettings` is the top-level two-pane search settings shell. It reads the
// active section from the URL (App Router mocks are supplied by the preview),
// renders the desktop master rail + section content (or an accordion when
// narrow), and composes every search panel. Section content reads
// `useSettingsStore`, so stories seed it.
const meta = {
  title: "Settings/Search/SearchSettings",
  component: SearchSettings,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings({ searchEnabled: false }) })
  },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-5xl p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchSettings>

export default meta
type Story = StoryObj<typeof meta>

// Fresh install: basics section active, no provider configured (config alert).
export const Default: Story = {}

// Search enabled with two configured providers.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        searchEnabled: true,
        searchProviders: makeConfiguredProviders(),
      }),
    })
  },
}
