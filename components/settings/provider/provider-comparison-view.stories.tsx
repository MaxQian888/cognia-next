import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderComparisonView } from "./provider-comparison-view"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeProviderSettingsMap } from "@/lib/storybook/fixtures/settings-provider"

// Global side-by-side model comparison. Available models come from the built-in
// catalog filtered by enabled providers (FLAT `providerSettings`, falling back
// to each provider's catalog `defaultEnabled`). No models selected → empty
// state; pick up to four from the "Add model" popover to populate the table.
const meta = {
  title: "Settings/Provider/ProviderComparisonView",
  component: ProviderComparisonView,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] flex-col border">
        <Story />
      </div>
    ),
  ],
  args: { onBack: fn() },
} satisfies Meta<typeof ProviderComparisonView>

export default meta
type Story = StoryObj<typeof meta>

// Empty store — only catalog default-enabled providers contribute model
// options. Nothing selected yet, so the empty state is shown.
export const Default: Story = {}

// Explicitly enabled built-in providers widen the "Add model" popover list.
export const ProvidersEnabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { providerSettings: makeProviderSettingsMap() })
  },
}
