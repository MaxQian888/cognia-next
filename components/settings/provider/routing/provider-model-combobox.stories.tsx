import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ProviderModelCombobox } from "./provider-model-combobox"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeProviderSettingsMap } from "@/lib/storybook/fixtures/settings-provider"
import type { AppSettings } from "@cognia/agent-config-types"

// Reusable provider:model picker. Option universe comes from the settings store
// (`providerSettings` + `customProviders` via `collectOptions`). Props control
// the current selection and the `onSelect` callback. Open the popover to browse.
const seedWith = (settings: Partial<AppSettings>) => () => {
  resetStore(useSettingsStore)
  seedStore(useSettingsStore, { settings: settings as AppSettings })
}

const meta = {
  title: "Settings/Provider/Routing/ProviderModelCombobox",
  component: ProviderModelCombobox,
  parameters: { layout: "padded" },
  beforeEach: seedWith({ providerSettings: makeProviderSettingsMap() }),
  args: { onSelect: fn() },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProviderModelCombobox>

export default meta
type Story = StoryObj<typeof meta>

// Nothing chosen yet — the trigger shows the placeholder label.
export const Unselected: Story = {
  args: {},
}

// A provider:model already selected — the trigger reflects the choice.
export const Selected: Story = {
  args: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
}

// No configured providers — opening the popover shows the empty state.
export const NoProviders: Story = {
  beforeEach: seedWith({ providerSettings: {} }),
  args: {},
}
