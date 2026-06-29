import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginsSection } from "./section-plugins"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/Settings/SectionPlugins",
  component: PluginsSection,
  args: { team: buildTeam() },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof PluginsSection>

export default meta
type Story = StoryObj<typeof meta>

// Team-level capability default pool editor (empty catalogs from a fresh DB).
export const Default: Story = {}
