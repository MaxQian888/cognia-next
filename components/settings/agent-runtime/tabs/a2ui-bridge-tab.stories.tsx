import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIBridgeTab } from "./a2ui-bridge-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"

// `A2UIBridgeTab` is a single switch controlling whether new sessions get the
// `mcp__a2ui-bridge__*` toolset by default (`AppSettings.a2uiDefaultEnabled`).
const meta = {
  title: "Settings/AgentRuntime/Tabs/A2UIBridgeTab",
  component: A2UIBridgeTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof A2UIBridgeTab>

export default meta
type Story = StoryObj<typeof meta>

// Default off.
export const Default: Story = {}

// Bridge enabled by default for new sessions.
export const Enabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({ a2uiDefaultEnabled: true }),
    })
  },
}
