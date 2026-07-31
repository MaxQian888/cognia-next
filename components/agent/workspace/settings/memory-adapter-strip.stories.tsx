import type { Meta, StoryObj } from "@storybook/nextjs"

import { MemoryAdapterStrip } from "./memory-adapter-strip"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings/MemoryAdapterStrip",
  component: MemoryAdapterStrip,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof MemoryAdapterStrip>

export default meta
type Story = StoryObj<typeof meta>

// No adapter configured → "none" badge, sync disabled.
export const NoAdapter: Story = {}
