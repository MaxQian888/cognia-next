import type { Meta, StoryObj } from "@storybook/nextjs"

import { DelegationsPanel } from "./delegations-panel"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

const meta = {
  title: "Agent/Workspace/DelegationsPanel",
  component: DelegationsPanel,
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof DelegationsPanel>

export default meta
type Story = StoryObj<typeof meta>

// No active delegations → empty state.
export const Empty: Story = {}
