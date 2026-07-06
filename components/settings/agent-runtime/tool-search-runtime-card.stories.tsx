import type { Meta, StoryObj } from "@storybook/nextjs"

import { ToolSearchRuntimeCard } from "./tool-search-runtime-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeAgentAppSettings,
  makeConfiguredPermissions,
} from "@/lib/storybook/fixtures/settings-agent"

// `ToolSearchRuntimeCard` edits `AppSettings.toolSearchRuntime`: a master
// toggle for on-demand (deferred) tool loading plus two allow-lists pinning
// specific MCP servers / bare tools as always-resident.
const meta = {
  title: "Settings/AgentRuntime/ToolSearchRuntimeCard",
  component: ToolSearchRuntimeCard,
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
} satisfies Meta<typeof ToolSearchRuntimeCard>

export default meta
type Story = StoryObj<typeof meta>

// Disabled — only the master toggle is shown.
export const Default: Story = {}

// Enabled with both allow-lists populated.
export const Enabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeConfiguredPermissions() })
  },
}
