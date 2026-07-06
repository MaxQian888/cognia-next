import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AgentTeamOverview } from "./overview"
import { buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const teammates = [
  buildTeammate({ id: "tm-lead", name: "Lead", role: "lead", status: "idle" }),
  buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate", status: "idle" }),
]

const meta = {
  title: "Agent/Workspace/Overview",
  component: AgentTeamOverview,
  args: {
    team: buildTeam({ status: "idle", config: { ...buildTeam().config, tokenBudget: 100_000 } }),
    teammates,
    onStart: fn(),
    onStartUltracode: fn(),
    onAbort: fn(),
    onUpdateTeam: fn(),
  },
} satisfies Meta<typeof AgentTeamOverview>

export default meta
type Story = StoryObj<typeof meta>

// Identity + config summary + runtime + token usage, with a Start action.
export const Idle: Story = {}

// Lead awaiting approval surfaces the inline plan-approval panel.
export const AwaitingApproval: Story = {
  args: {
    team: buildTeam({
      status: "planning",
      config: { ...buildTeam().config, requirePlanApproval: true },
    }),
    teammates: [
      buildTeammate({
        id: "tm-lead",
        name: "Lead",
        role: "lead",
        status: "awaiting_approval",
        proposedPlan: "1. Reproduce\n2. Patch\n3. Ship",
      }),
      ...teammates.slice(1),
    ],
  },
}
