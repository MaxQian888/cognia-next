import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentTeamActivity } from "./activity"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildReport, buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const teammates = [buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate" })]

const meta = {
  title: "Agent/Workspace/Activity",
  component: AgentTeamActivity,
  args: {
    events: [],
    report: buildReport(),
    team: buildTeam(),
    teammates,
  },
  beforeEach: () => {
    // ConsensusPanel + DelegationsPanel read the team store.
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof AgentTeamActivity>

export default meta
type Story = StoryObj<typeof meta>

// Rich report: KPI cards, taskline, token-burn, timeline + consensus/delegations.
export const WithReport: Story = {}

// No report → consensus + delegations panels only.
export const NoReport: Story = {
  args: { report: undefined },
}
