import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { AgentFlowDisplayToggle } from "./agent-flow-display-toggle"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@cognia/agent-config-types"
import type { AgentFlowMode } from "@/types/appearance"

// Seed the settings store with a given flow mode and stub `save` so clicking a
// segment re-renders without persisting to Dexie/Tauri.
const seedMode = (mode: AgentFlowMode) => async () => {
  useSettingsStore.setState({
    settings: { agentFlowMode: { mode } } as AppSettings,
    save: async () => {},
  })
}

const meta = {
  title: "Chat/AgentFlowDisplayToggle",
  component: AgentFlowDisplayToggle,
  beforeEach: seedMode("standard"),
} satisfies Meta<typeof AgentFlowDisplayToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Standard: Story = {}

export const Simplified: Story = {
  beforeEach: seedMode("simplified"),
}

export const Detailed: Story = {
  beforeEach: seedMode("detailed"),
}
