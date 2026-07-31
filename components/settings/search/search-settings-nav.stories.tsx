import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SearchSettingsNav } from "./search-settings-nav"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makeConfiguredProviders,
} from "@/lib/storybook/fixtures/settings-search"

// `SearchSettingsNav` is the desktop left rail. Props pick the active section;
// the "providers" row carries an enabled/total badge derived from the store.
const meta = {
  title: "Settings/Search/SearchSettingsNav",
  component: SearchSettingsNav,
  parameters: { layout: "padded" },
  args: { active: "basics", onSelect: fn() },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="w-52">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchSettingsNav>

export default meta
type Story = StoryObj<typeof meta>

// Basics active, no provider enabled → 0/10 badge.
export const BasicsActive: Story = {}

export const ProvidersActive: Story = {
  args: { active: "providers" },
}

// Two providers configured + enabled → 2/10 badge on the providers row.
export const WithEnabledProviders: Story = {
  args: { active: "providers" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchProviders: makeConfiguredProviders() }),
    })
  },
}

export const DiagnosticsActive: Story = {
  args: { active: "diagnostics" },
}
