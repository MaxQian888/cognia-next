import type { Meta, StoryObj } from "@storybook/nextjs"

import { UltracodeSection } from "./section-ultracode"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings/SectionUltracode",
  component: UltracodeSection,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof UltracodeSection>

export default meta
type Story = StoryObj<typeof meta>

// Ultracode disabled by default → fan-out knobs are disabled.
export const Disabled: Story = {}

// Enabled with auto-orchestration → knobs become editable.
export const Enabled: Story = {
  args: {
    team: buildTeam({
      config: {
        maxTeammates: 5,
        maxConcurrentTeammates: 3,
        executionMode: "coordinated",
        displayMode: "expanded",
        ultracode: { enabled: true, autoMode: "auto" },
      },
    }),
  },
}
