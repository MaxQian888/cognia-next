import type { Meta, StoryObj } from "@storybook/nextjs"

import { AgentMentionRow, SubagentMentionRow } from "./agent-mention-picker"
import { buildRouteTargets } from "@/lib/agent-team/runtime-targets"
import { buildTeam, buildTeammate } from "@/lib/storybook/fixtures/agent-team"

const targets = buildRouteTargets({
  squads: [
    {
      team: buildTeam(),
      teammates: [
        buildTeammate({
          id: "tm-coder",
          name: "Coder",
          role: "teammate",
          description: "Implements the fix and runs the suite.",
          config: { runtime: "codex" },
        }),
      ],
    },
  ],
})

// Last entry is the Squad member; the first two are the built-in virtual targets.
const teammateTarget = targets[targets.length - 1]
const virtualTarget = targets[0]
const codexTarget = targets[1]

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

// `@claude` names the engine that will really answer the turn.
export const Virtual: Story = {
  args: {
    target: virtualTarget,
    lane: { ok: true, runtimeRef: { kind: "builtin" } },
    descriptor: {
      ref: { kind: "builtin" },
      key: "builtin",
      group: "builtin",
      descriptionKey: "engineClaudeAgentSdk",
    },
  },
}

// A route whose runtime cannot run here is dimmed with the reason.
export const Unavailable: Story = {
  args: {
    target: codexTarget,
    lane: { ok: false, reason: "not-configured", runtime: "codex" },
  },
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
