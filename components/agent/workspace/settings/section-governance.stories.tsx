import type { Meta, StoryObj } from "@storybook/nextjs"

import { GovernanceSection } from "./section-governance"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings/SectionGovernance",
  component: GovernanceSection,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof GovernanceSection>

export default meta
type Story = StoryObj<typeof meta>

// Approval / budget / escalation / re-plan / refusal controls (default policy).
export const Default: Story = {}
