import type { Meta, StoryObj } from "@storybook/nextjs"

import { SubagentNestingCard } from "./subagent-nesting-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import { makeAgentAppSettings } from "@/lib/storybook/fixtures/settings-agent"

// `SubagentNestingCard` is the opt-in config for nested subagent dispatch
// (depth-N), backing `AppSettings.subagentNesting`. When disabled, the
// depth/budget/timeout inputs are greyed out; the card owns its own save.
const meta = {
  title: "Settings/Subagents/SubagentNestingCard",
  component: SubagentNestingCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { settings: makeAgentAppSettings() })
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-lg border p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentNestingCard>

export default meta
type Story = StoryObj<typeof meta>

// Disabled — depth/budget/timeout inputs are inert.
export const Default: Story = {}

// Enabled with a configured depth, token budget, and timeout.
export const Enabled: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      settings: makeAgentAppSettings({
        subagentNesting: { enabled: true, maxDepth: 3, tokenBudget: 200000, timeoutMs: 120000 },
      }),
    })
  },
}
