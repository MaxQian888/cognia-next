import type { Meta, StoryObj } from "@storybook/nextjs"

import { OpenRouterSettings } from "./openrouter-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeUserProviderSettings,
  makeDiscoveredModel,
} from "@/lib/storybook/fixtures/settings-provider"
import type { UserProviderSettings } from "@cognia/provider-types/provider"

// OpenRouter BYOK / credits / provider-ordering panel. Reads the FLAT
// `providerSettings.openrouter` row and renders NOTHING unless enabled. Credits
// are only fetched on mount when an apiKey exists AND `creditsLastFetched` is
// unset, so seeding `creditsLastFetched` keeps the network out of the story.
const seed =
  (over: Partial<UserProviderSettings> = {}) =>
  () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      providerSettings: {
        openrouter: makeUserProviderSettings({
          providerId: "openrouter",
          enabled: true,
          apiKey: "sk-or-v1-key-example",
          openRouterSettings: {
            credits: 50,
            creditsUsed: 12.5,
            creditsRemaining: 37.5,
            creditsLastFetched: Date.UTC(2026, 5, 28, 9, 0, 0),
          },
          ...over,
        }),
      },
    })
  }

const meta = {
  title: "Settings/Provider/OpenRouterSettings",
  component: OpenRouterSettings,
  parameters: { layout: "padded" },
  beforeEach: seed(),
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof OpenRouterSettings>

export default meta
type Story = StoryObj<typeof meta>

// Enabled with cached credits — credits card + collapsed model/BYOK sections.
export const Default: Story = {}

// A populated discovered-models list inside the "Available Models" section.
export const WithDiscoveredModels: Story = {
  beforeEach: seed({
    discoveredModels: [
      makeDiscoveredModel({ id: "openai/gpt-4.1", name: "OpenAI: GPT-4.1" }),
      makeDiscoveredModel({
        id: "anthropic/claude-sonnet-4-6",
        name: "Anthropic: Claude Sonnet 4.6",
      }),
      makeDiscoveredModel({ id: "google/gemini-2.5-pro", name: "Google: Gemini 2.5 Pro" }),
    ],
  }),
}
