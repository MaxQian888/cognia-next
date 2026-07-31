import type { Meta, StoryObj } from "@storybook/nextjs"

import { MemorySection } from "./section-memory"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings/SectionMemory",
  component: MemorySection,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof MemorySection>

export default meta
type Story = StoryObj<typeof meta>

// No shared-memory entries → adapter strip + filter toolbar + empty state.
export const Empty: Story = {}
