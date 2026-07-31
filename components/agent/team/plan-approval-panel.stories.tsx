import type { Meta, StoryObj } from "@storybook/nextjs"

import { PlanApprovalPanel } from "./plan-approval-panel"
import { buildTeam, buildTeammate, SAMPLE_PROPOSED_PLAN } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Team/PlanApprovalPanel",
  component: PlanApprovalPanel,
  args: {
    team: buildTeam(),
    lead: buildTeammate({ proposedPlan: SAMPLE_PROPOSED_PLAN }),
  },
} satisfies Meta<typeof PlanApprovalPanel>

export default meta
type Story = StoryObj<typeof meta>

// Lead has proposed a plan → approve / reject enabled.
export const WithPlan: Story = {}

// No proposed plan yet → empty state, buttons disabled.
export const NoPlan: Story = {
  args: { lead: buildTeammate({ proposedPlan: undefined }) },
}
