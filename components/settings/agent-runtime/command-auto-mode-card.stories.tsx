import type { Meta, StoryObj } from "@storybook/nextjs"

import { CommandAutoModeCard } from "./command-auto-mode-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import {
  makeAgentAppSettings,
  makeConfiguredPermissions,
} from "@/lib/storybook/fixtures/settings-agent"

// `CommandAutoModeCard` edits `AppSettings.agentPermissions.autoApprove` +
// `commandRules`. With null settings it shows the master switch off; turning it
// on reveals the engine select + the per-command rule editor.
const meta = {
  title: "Settings/AgentRuntime/CommandAutoModeCard",
  component: CommandAutoModeCard,
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
} satisfies Meta<typeof CommandAutoModeCard>

export default meta
type Story = StoryObj<typeof meta>

// Auto-mode disabled — only the master switch is shown.
export const Default: Story = {}

// Auto-mode on, rules+model engine, with a few pinned command rules.
export const Configured: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeConfiguredPermissions() })
  },
}
