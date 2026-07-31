import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LocalProviderSettings } from "./local-provider-settings"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeUserProviderSettings } from "@/lib/storybook/fixtures/settings-provider"

// Unified local-inference panel (Ollama / LM Studio / vLLM / …). Reads the FLAT
// `providerSettings` map for enable + base-URL state. On mount it scans for
// installed/running providers; those probes are Tauri/network calls that no-op
// in Storybook, so the cards render their disconnected state.
const meta = {
  title: "Settings/Provider/LocalProviderSettings",
  component: LocalProviderSettings,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
  args: { onProviderSelect: fn() },
} satisfies Meta<typeof LocalProviderSettings>

export default meta
type Story = StoryObj<typeof meta>

// Nothing configured — grouped provider list, all disconnected.
export const Default: Story = {}

// Ollama enabled with a custom base URL (its card shows the enabled toggle on).
export const WithOllamaEnabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      providerSettings: {
        ollama: makeUserProviderSettings({
          providerId: "ollama",
          enabled: true,
          apiKey: undefined,
          baseURL: "http://localhost:11434",
        }),
      },
    })
  },
}
