import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TeammateConfigDialog } from "./teammate-config-dialog"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const meta = {
  title: "Agent/Workspace/TeammateConfigDialog",
  component: TeammateConfigDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    teammate: buildTeammate({
      id: "tm-coder",
      name: "Coder",
      role: "teammate",
      config: { runtime: "codex", specialization: "backend" },
    }),
    team: buildTeam(),
  },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof TeammateConfigDialog>

export default meta
type Story = StoryObj<typeof meta>

// Hosts the shared PresetEditor plus roster-specific extra sections.
export const Default: Story = {}
