import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTeamMembers } from "./members"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const team = buildTeam()
const teammates = [
  buildTeammate({ id: "tm-lead", name: "Lead", role: "lead", status: "executing" }),
  buildTeammate({
    id: "tm-coder",
    name: "Coder",
    role: "teammate",
    status: "idle",
    config: { runtime: "codex", specialization: "backend" },
    description: "Implements the fix and runs the suite.",
  }),
]

const meta = {
  title: "Agent/Workspace/Members",
  component: AgentTeamMembers,
  args: { team, teammates, leadId: "tm-lead" },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof AgentTeamMembers>

export default meta
type Story = StoryObj<typeof meta>

// Lead card + worker grid with per-member runtime selectors.
export const WithMembers: Story = {}

// No teammates → empty state with an add CTA.
export const Empty: Story = {
  args: { teammates: [] },
}
