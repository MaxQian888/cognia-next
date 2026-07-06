import type { Meta, StoryObj } from "@storybook/nextjs"

import { PermissionsToolsTab } from "./permissions-tools-tab"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeAgentAppSettings,
  makeConfiguredPermissions,
} from "@/lib/storybook/fixtures/settings-agent"

// `PermissionsToolsTab` composes the command/tool rule cards with the
// always-allow editor and the built-in tool-category grid. The category
// switches are desktop-only (the cognia-tools MCP server lives in the Tauri
// sidecar), so on the web preview they render disabled with a hint.
const meta = {
  title: "Settings/AgentRuntime/Tabs/PermissionsToolsTab",
  component: PermissionsToolsTab,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-3xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PermissionsToolsTab>

export default meta
type Story = StoryObj<typeof meta>

// Default (empty) settings — desktop-only category switches disabled on web.
export const Default: Story = {}

// Configured command + tool rules feeding the embedded rule cards.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeConfiguredPermissions() })
  },
}
