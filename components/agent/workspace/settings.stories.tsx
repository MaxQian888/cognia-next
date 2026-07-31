import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTeamSettings } from "./settings"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings",
  component: AgentTeamSettings,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof AgentTeamSettings>

export default meta
type Story = StoryObj<typeof meta>

// Save indicator + accordion (overview/plugins/governance/ultracode/memory) + danger zone.
export const Default: Story = {}
