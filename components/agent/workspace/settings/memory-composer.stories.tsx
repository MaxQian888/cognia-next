import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryComposer } from "./memory-composer"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { buildTeam } from "@/lib/storybook/fixtures/agent-team"
import type { SharedMemoryEntry } from "@/types/agent/agent-team"

const existing: SharedMemoryEntry = {
  key: "decision.reducer-fix",
  value: "Patch computePlanCounts to use <= instead of <.",
  writtenBy: "tm-lead",
  writtenAt: new Date("2026-06-29T10:00:00.000Z"),
  version: 1,
  tags: ["decision"],
}

const meta = {
  title: "Agent/Workspace/Settings/MemoryComposer",
  component: MemoryComposer,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    team: buildTeam(),
    mode: "create",
  },
  beforeEach: () => {
    resetStore(useAgentTeamStore)
  },
} satisfies Meta<typeof MemoryComposer>

export default meta
type Story = StoryObj<typeof meta>

export const Create: Story = {}

export const Edit: Story = {
  args: { mode: "edit", initial: existing },
}
