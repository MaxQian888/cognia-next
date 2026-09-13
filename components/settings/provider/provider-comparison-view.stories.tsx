import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { fn } from "storybook/test"

import { ProviderComparisonView, comparisonModelKey } from "./provider-comparison-view"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeProviderSettingsMap } from "@/lib/storybook/fixtures/settings-provider"

// Side-by-side model comparison. The selection is CONTROLLED (the settings
// pane owns it and persists it as `comparisonModelKeys`), so each story holds
// it in local state. Available models come from the whole built-in catalog;
// enabled providers lead the "Add model" picker and disabled ones are labelled.
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
  args: { onBack: fn(), selectedModelKeys: [], onSelectedModelKeysChange: fn() },
  render: function Render(args) {
    const [keys, setKeys] = useState<readonly string[]>(args.selectedModelKeys)
    return (
      <ProviderComparisonView
        {...args}
        selectedModelKeys={keys}
        onSelectedModelKeysChange={(next) => {
          args.onSelectedModelKeysChange(next)
          setKeys(next)
        }}
      />
    )
  },
} satisfies Meta<typeof ProviderComparisonView>

export default meta
type Story = StoryObj<typeof meta>

// Nothing selected yet: the empty state points at the Models tab and the picker.
export const Default: Story = {}

// A three-way comparison with sections, a marked best value per numeric row
// and the "only differences" toggle live.
export const ThreeModels: Story = {
  args: {
    selectedModelKeys: [
      comparisonModelKey("openai", "gpt-4.1"),
      comparisonModelKey("anthropic", "claude-sonnet-4-6"),
      comparisonModelKey("google", "gemini-2.5-pro"),
    ],
  },
}

// Explicitly enabled built-in providers lead the "Add model" picker.
export const ProvidersEnabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { providerSettings: makeProviderSettingsMap() })
  },
}
