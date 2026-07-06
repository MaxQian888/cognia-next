import type { Meta, StoryObj } from "@storybook/nextjs"

import { OpenRouterKeyManagement } from "./openrouter-key-management"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeUserProviderSettings } from "@/lib/storybook/fixtures/settings-provider"

// OpenRouter provisioning-API key manager. Reads the FLAT
// `providerSettings.openrouter.openRouterSettings.provisioningApiKey`. Without a
// provisioning key only the input is shown; with one, the create-key control and
// keys table appear (the live key list is fetched over the network, no-op here).
const meta = {
  title: "Settings/Provider/OpenRouterKeyManagement",
  component: OpenRouterKeyManagement,
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
} satisfies Meta<typeof OpenRouterKeyManagement>

export default meta
type Story = StoryObj<typeof meta>

// No provisioning key set — just the key input + hint.
export const Default: Story = {}

// Provisioning key present — create button + (empty, post-fetch) keys section.
export const WithProvisioningKey: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      providerSettings: {
        openrouter: makeUserProviderSettings({
          providerId: "openrouter",
          openRouterSettings: { provisioningApiKey: "sk-or-v1-provisioning-key-example" },
        }),
      },
    })
  },
}
