import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentMentionRow, SubagentMentionRow } from "./agent-mention-picker"
import { buildMentionableTargets } from "@/lib/agent-team/runtime-targets"
import { buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const targets = buildMentionableTargets([
  buildTeammate({
    id: "tm-coder",
    name: "Coder",
    role: "teammate",
    description: "Implements the fix and runs the suite.",
    config: { runtime: "codex" },
  }),
])

// Last entry is the teammate; earlier ones are the built-in virtual targets.
const teammateTarget = targets[targets.length - 1]
const virtualTarget = targets[0]

const meta = {
  title: "Agent/Workspace/AgentMentionRow",
  component: AgentMentionRow,
  args: { target: teammateTarget },
  decorators: [
    (Story) => (
      <div className="w-72 rounded-md border p-1">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AgentMentionRow>

export default meta
type Story = StoryObj<typeof meta>

export const Teammate: Story = {}

export const Highlighted: Story = {
  args: { highlighted: true },
}

// A built-in virtual runtime target shows the "virtual" tag.
export const Virtual: Story = {
  args: { target: virtualTarget },
}

// The sibling subagent row (model badge instead of a runtime badge).
export const Subagent: Story = {
  render: () => (
    <SubagentMentionRow
      target={{
        id: "sub-1",
        name: "Reviewer",
        handle: "reviewer",
        description: "Reviews diffs for correctness.",
        model: "claude-sonnet",
      }}
    />
  ),
}
