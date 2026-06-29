import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchProviderCompare } from "./search-provider-compare"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makeConfiguredProviders,
} from "@/lib/storybook/fixtures/settings-search"

// `SearchProviderCompare` runs the same query against two providers side by side.
// The provider dropdowns are populated from configured providers in
// `useSettingsStore`; the live comparison only fires on user action, so the
// default render is the empty form.
const meta = {
  title: "Settings/Search/SearchProviderCompare",
  component: SearchProviderCompare,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchProviders: makeConfiguredProviders() }),
    })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchProviderCompare>

export default meta
type Story = StoryObj<typeof meta>

// Two configured providers selectable in the A/B dropdowns.
export const TwoConfigured: Story = {}

// No configured providers → the dropdowns are empty, compare stays unusable.
export const NoConfiguredProviders: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
}
