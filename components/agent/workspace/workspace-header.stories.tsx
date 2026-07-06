import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkspaceHeader } from "./workspace-header"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const teammates = [
  buildTeammate({ id: "lead", name: "Lead", role: "lead" }),
  buildTeammate({ id: "w1", name: "Researcher", role: "teammate", status: "executing" }),
  buildTeammate({ id: "w2", name: "Writer", role: "teammate" }),
]

const meta = {
  title: "Agent/Workspace/WorkspaceHeader",
  component: WorkspaceHeader,
  parameters: { layout: "padded" },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
  args: {
    team: buildTeam({
      name: "Demo Research Squad",
      description: "Investigate the competitive landscape and synthesise a briefing.",
      status: "executing",
      totalTokenUsage: { promptTokens: 4200, completionTokens: 1700, totalTokens: 5900 },
      totalDuration: 545_000,
    }),
    teammates,
  },
} satisfies Meta<typeof WorkspaceHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Running: Story = {}

export const Idle: Story = {
  args: {
    team: buildTeam({ name: "Fresh Squad", description: "A newly created team.", status: "idle" }),
    teammates: [buildTeammate({ id: "lead", name: "Lead", role: "lead" })],
  },
}
