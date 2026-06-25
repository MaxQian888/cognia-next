import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { RuntimeQueryCard } from "./runtime-query-card"

function makePart(output: unknown): ToolUIPart {
  return {
    type: "tool-runtime_query",
    toolCallId: "c1",
    state: "output-available",
    input: { kind: "skill" },
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/RuntimeQueryCard",
  component: RuntimeQueryCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof RuntimeQueryCard>

export default meta
type Story = StoryObj<typeof meta>

export const Skills: Story = {
  args: {
    part: makePart({
      kind: "skill",
      entities: [
        {
          id: "preflight",
          name: "preflight",
          description:
            "Pre-commit audit fan-out over the current diff, ending with the exact gate commands.",
        },
        {
          id: "dexie-migration",
          name: "dexie-migration",
          description: "Add a new Dexie schema version to lib/db/schema.ts safely.",
        },
      ],
    }),
  },
}

export const AgentTeam: Story = {
  args: {
    part: makePart({
      entityType: "agent-team",
      entities: [
        {
          id: "researcher",
          name: "Researcher",
          description: "Fans out web searches and synthesizes findings.",
        },
        {
          id: "reviewer",
          name: "Reviewer",
          description: "Audits the diff for correctness and reuse.",
        },
      ],
    }),
  },
}

export const NoneFound: Story = {
  args: { part: makePart({ kind: "plugin", entities: [] }) },
}
