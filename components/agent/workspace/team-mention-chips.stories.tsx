import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TeamMentionChips } from "./team-mention-chips"
import { buildMentionableTargets } from "@/lib/agent-team/runtime-targets"
import { buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const targets = buildMentionableTargets([
  buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate", config: { runtime: "claude" } }),
  buildTeammate({
    id: "tm-codex",
    name: "Codex",
    role: "teammate",
    config: { runtime: "codex" },
  }),
])

const meta = {
  title: "Agent/Workspace/TeamMentionChips",
  component: TeamMentionChips,
  args: { targets, onPick: fn() },
} satisfies Meta<typeof TeamMentionChips>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// An unavailable runtime dims its chip and shows a setup tooltip.
export const WithUnavailable: Story = {
  args: { availability: { codex: "no-agent" } },
}

// No targets → renders nothing.
export const Empty: Story = {
  args: { targets: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing → <TeamMentionChips {...args} />
    </div>
  ),
}
