import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentFlowCard } from "./agent-flow-card"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { makeAppSettings } from "@/lib/storybook/fixtures/settings-system"

// Agent invocation-flow display mode select (simplified / standard / detailed).
// Reads/writes `settings.agentFlowMode` via `useAgentFlowMode`.
const meta = {
  title: "Settings/Appearance/AgentFlowCard",
  component: AgentFlowCard,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, { loaded: true, settings: makeAppSettings() })
  },
} satisfies Meta<typeof AgentFlowCard>

export default meta
type Story = StoryObj<typeof meta>

// Default mode.
export const Default: Story = {}

// Detailed mode pre-selected.
export const Detailed: Story = {
  beforeEach: () => {
    resetStore(useSettingsStore)
    seedStore(useSettingsStore, {
      loaded: true,
      settings: makeAppSettings({ agentFlowMode: { mode: "detailed" } }),
    })
  },
}
