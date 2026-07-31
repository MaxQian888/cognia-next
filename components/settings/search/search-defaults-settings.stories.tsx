import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchDefaultsSettings } from "./search-defaults-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeSearchAppSettings } from "@/lib/storybook/fixtures/settings-search"

// `SearchDefaultsSettings` edits the default search behaviour (type, depth,
// recency, country/language, include/exclude domains, answer/raw-content
// toggles) from `useSettingsStore`. With null settings it shows library defaults.
const meta = {
  title: "Settings/Search/SearchDefaultsSettings",
  component: SearchDefaultsSettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeSearchAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchDefaultsSettings>

export default meta
type Story = StoryObj<typeof meta>

export const Defaults: Story = {}

// A richly customised configuration: academic + deep, week recency, geo/lang
// hints and populated include/exclude domain lists.
export const Customized: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({
        defaultSearchType: "academic",
        defaultSearchDepth: "deep",
        defaultSearchRecency: "week",
        defaultSearchCountry: "US",
        defaultSearchLanguage: "en",
        defaultIncludeDomains: ["arxiv.org", "nature.com"],
        defaultExcludeDomains: ["pinterest.com"],
        defaultIncludeAnswer: true,
        defaultIncludeRawContent: true,
      }),
    })
  },
}
