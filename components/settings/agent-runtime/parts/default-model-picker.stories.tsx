import type { Meta, StoryObj } from "@storybook/nextjs"

import { DefaultModelPicker } from "./default-model-picker"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeAgentAppSettings,
  makeConfiguredDefaults,
} from "@/lib/storybook/fixtures/settings-agent"

// `DefaultModelPicker` is the popover combobox that persists
// `AppSettings.defaultModel` + `defaultProvider`. It reads the same provider
// whitelist as the composer model picker (via `collectOptions`/`groupByProvider`
// over `providerSettings` + `customProviders`). With no configured providers the
// trigger shows the "unset" label and the list is empty.
const meta = {
  title: "Settings/AgentRuntime/DefaultModelPicker",
  component: DefaultModelPicker,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-sm">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DefaultModelPicker>

export default meta
type Story = StoryObj<typeof meta>

// No default model picked — trigger shows the "unset" label.
export const Unset: Story = {}

// A pinned default model + provider (trigger shows the model id).
export const WithSelection: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeConfiguredDefaults() })
  },
}
