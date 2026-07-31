import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConsensusPanel } from "./consensus-panel"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

const meta = {
  title: "Agent/Workspace/ConsensusPanel",
  component: ConsensusPanel,
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof ConsensusPanel>

export default meta
type Story = StoryObj<typeof meta>

// No active consensus rows → empty state.
export const Empty: Story = {}
