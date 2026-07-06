import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderCostTab } from "./provider-cost-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeProviderUsageEntry } from "@/lib/storybook/fixtures/settings-provider"
import type { ProviderModelUsageEntry } from "@cognia/provider-types/provider"

// Per-provider cost breakdown. Reads the FLAT `providerUsageStats` map keyed by
// `${providerId}:${modelId}`, aggregates it per day, and prices it from the
// built-in catalog. Empty stats render the empty state.
const recent = (daysAgo: number): string => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return d.toISOString()
}

const POPULATED_USAGE: Record<string, ProviderModelUsageEntry[]> = {
  "openai:gpt-4.1": [
    makeProviderUsageEntry({
      at: recent(0),
      modelId: "gpt-4.1",
      promptTokens: 42_000,
      completionTokens: 12_000,
    }),
    makeProviderUsageEntry({
      at: recent(2),
      modelId: "gpt-4.1",
      promptTokens: 18_500,
      completionTokens: 6_400,
    }),
    makeProviderUsageEntry({
      at: recent(20),
      modelId: "gpt-4.1",
      promptTokens: 9_000,
      completionTokens: 3_200,
    }),
  ],
  "openai:gpt-4.1-mini": [
    makeProviderUsageEntry({
      at: recent(1),
      modelId: "gpt-4.1-mini",
      promptTokens: 120_000,
      completionTokens: 30_000,
    }),
    makeProviderUsageEntry({
      at: recent(5),
      modelId: "gpt-4.1-mini",
      promptTokens: 88_000,
      completionTokens: 21_000,
    }),
  ],
}

const meta = {
  title: "Settings/Provider/ProviderCostTab",
  component: ProviderCostTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: { providerId: "openai" },
} satisfies Meta<typeof ProviderCostTab>

export default meta
type Story = StoryObj<typeof meta>

// No usage recorded for the provider — empty state.
export const Empty: Story = {}

// Populated usage across two models with recent timestamps — overview cards +
// per-model cost table priced from the catalog.
export const Populated: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { providerUsageStats: POPULATED_USAGE })
  },
}
