import type { Meta, StoryObj } from "@storybook/nextjs"

import { ToolPermissionRulesCard } from "./tool-permission-rules-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeAgentAppSettings,
  makeConfiguredPermissions,
} from "@/lib/storybook/fixtures/settings-agent"

// `ToolPermissionRulesCard` is the multi-tool generalization of the command
// rules card: per-tool `input-glob → allow|ask|deny` rules over
// `AppSettings.agentPermissions.toolRules`, with a live "which rule wins?"
// preview that calls the runtime resolver.
const meta = {
  title: "Settings/AgentRuntime/ToolPermissionRulesCard",
  component: ToolPermissionRulesCard,
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
} satisfies Meta<typeof ToolPermissionRulesCard>

export default meta
type Story = StoryObj<typeof meta>

// No tool rules yet — empty list + add-rule controls + preview box.
export const Default: Story = {}

// A populated ruleset (Bash glob allow + a wildcard env deny).
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeConfiguredPermissions() })
  },
}
