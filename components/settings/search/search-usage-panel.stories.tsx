import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchUsagePanel } from "./search-usage-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeSearchAppSettings,
  makePopulatedUsageStats,
} from "@/lib/storybook/fixtures/settings-search"

// `SearchUsagePanel` aggregates per-provider usage stats from `useSettingsStore`
// into totals, averages and a most-used summary, with a reset action. With zero
// activity it shows the "no data" empty state.
const meta = {
  title: "Settings/Search/SearchUsagePanel",
  component: SearchUsagePanel,
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
} satisfies Meta<typeof SearchUsagePanel>

export default meta
type Story = StoryObj<typeof meta>

// No searches recorded → empty state.
export const NoData: Story = {}

// Tavily + Brave with real counts → summary cards, per-provider bars, errors.
export const WithUsage: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeSearchAppSettings({ searchUsageStats: makePopulatedUsageStats() }),
    })
  },
}
