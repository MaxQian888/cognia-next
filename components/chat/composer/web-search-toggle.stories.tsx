import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

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
  // The toggle renders as a `+`-menu row — preview it at the popover's width.
  decorators: [
    (Story: () => React.ReactElement) => (
      <div className="w-64 rounded-md border border-border bg-popover p-1">
        <Story />
      </div>
    ),
  ],
  args: { onOpenSettings: fn() },
  beforeEach: seed({ searchReady: true, on: false }),
} satisfies Meta<typeof WebSearchToggle>

export default meta
type Story = StoryObj<typeof meta>

// Provider configured, toggle off → plain row, "off" tooltip.
export const Off: Story = {}

// Provider configured, toggle on → active dot, tooltip naming the provider.
export const On: Story = {
  beforeEach: seed({ searchReady: true, on: true }),
}

// No configured search provider → the row stops being a toggle and opens a
// setup card instead: the reason, plus a button that jumps to the settings
// section that can fix it (the reason is the row's second line on mobile,
// where there is no hover).
export const NoProvider: Story = {
  beforeEach: seed({ searchReady: false, on: false }),
}
