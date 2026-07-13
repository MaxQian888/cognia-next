import type { Meta, StoryObj } from "@storybook/nextjs"

import { WebSearchToggle } from "./web-search-toggle"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"

// The toggle derives its enabled/active state from two stores:
//  - settings: `searchEnabled` + at least one configured+enabled provider
//  - chat:     `webSearchOnForNextSend` (the pressed state)
function seed(opts: { searchReady: boolean; on: boolean }) {
  return async () => {
    useSettingsStore.setState({
      settings: {
        searchEnabled: opts.searchReady,
        defaultSearchProvider: "tavily",
        searchProviders: {
          tavily: {
            providerId: "tavily",
            apiKey: opts.searchReady ? "tvly-demo-key" : "",
            enabled: opts.searchReady,
            priority: 1,
          },
        },
      } as unknown as AppSettings,
    })
    useChatStore.setState({ webSearchOnForNextSend: opts.on })
  }
}

const meta = {
  title: "Chat/Composer/WebSearchToggle",
  component: WebSearchToggle,
  parameters: { layout: "padded" },
  beforeEach: seed({ searchReady: true, on: false }),
} satisfies Meta<typeof WebSearchToggle>

export default meta
type Story = StoryObj<typeof meta>

// Provider configured, toggle off → ghost button, "off" tooltip.
export const Off: Story = {}

// Provider configured, toggle on → filled primary button naming the provider.
export const On: Story = {
  beforeEach: seed({ searchReady: true, on: true }),
}

// No configured search provider → disabled with the "configure first" tooltip.
export const NoProvider: Story = {
  beforeEach: seed({ searchReady: false, on: false }),
}
