import type { Meta, StoryObj } from "@storybook/nextjs"

import { SearchProviderKeyList } from "./search-provider-key-list"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// BYOK per-provider search key editor. Reads `settings.searchProviders` (falls
// back to defaults) and the settings-store setters. Stories show the unconfigured
// default list and a list with one configured + enabled provider.
const meta = {
  title: "Mobile/Me/SearchProviderKeyList",
  component: SearchProviderKeyList,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-[760px] w-[390px] overflow-y-auto border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SearchProviderKeyList>

export default meta
type Story = StoryObj<typeof meta>

export const Unconfigured: Story = {}

export const TavilyConfigured: Story = {
  beforeEach: () => {
    useSettingsStore.setState({
      settings: {
        searchProviders: {
          tavily: {
            providerId: "tavily",
            apiKey: "tvly-demo-1234567890",
            enabled: true,
            priority: 1,
          },
        },
      } as unknown as AppSettings,
    })
  },
}
