import type { Meta, StoryObj } from "@storybook/nextjs"

import { OverviewSection } from "./section-overview"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings/SectionOverview",
  component: OverviewSection,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof OverviewSection>

export default meta
type Story = StoryObj<typeof meta>

// General + execution + controls cards, each eager-saving via the store.
export const Default: Story = {}
