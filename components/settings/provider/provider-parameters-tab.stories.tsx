import type { Meta, StoryObj } from "@storybook/nextjs"

import { ProviderParametersTab } from "./provider-parameters-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeUserProviderSettings,
  makeModelConfig,
} from "@/lib/storybook/fixtures/settings-provider"

// Collapsible dynamic parameter form driven by the per-provider schema. The
// current values come from the `settings` prop; edits are persisted through
// `useSettingsStore` parameter-setter actions (reset here so they exist as
// no-op-safe store methods).
const meta = {
  title: "Settings/Provider/ProviderParametersTab",
  component: ProviderParametersTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    providerId: "openai",
    settings: makeUserProviderSettings({ providerId: "openai" }),
  },
} satisfies Meta<typeof ProviderParametersTab>

export default meta
type Story = StoryObj<typeof meta>

// OpenAI schema with no overrides — every field shows its placeholder default.
export const Default: Story = {}

// Pre-filled inference defaults (temperature / maxTokens / topP).
export const WithInferenceValues: Story = {
  args: {
    settings: makeUserProviderSettings({
      providerId: "openai",
      inferenceDefaults: { temperature: 0.7, maxTokens: 4096, topP: 0.9 },
    }),
  },
}

// Anthropic schema — exercises a different provider's parameter set, plus a
// model config that bounds the inference inputs.
export const AnthropicWithModelConfig: Story = {
  args: {
    providerId: "anthropic",
    settings: makeUserProviderSettings({ providerId: "anthropic" }),
    modelConfig: makeModelConfig({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      maxOutputTokens: 64_000,
    }),
  },
}
