import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AgentModeSelector } from "./mode-selector"
import { resetStores } from "@/lib/storybook/seed-stores"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

const meta = {
  title: "Agent/Mode/ModeSelector",
  component: AgentModeSelector,
  args: {
    selectedModeId: "general",
    onModeChange: fn(),
    onCustomModeCreate: fn(),
    onCreateTeam: fn(),
    onSelectTeam: fn(),
  },
  beforeEach: () => {
    resetStores(useCustomModeStore, useAgentTeamStore)
  },
} satisfies Meta<typeof AgentModeSelector>

export default meta
type Story = StoryObj<typeof meta>

// Built-in "general" mode selected; open the dropdown to browse all modes.
export const Default: Story = {}

export const PlanMode: Story = {
  args: { selectedModeId: "plan" },
}

export const Disabled: Story = {
  args: { disabled: true },
}
