import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { PlanCard } from "./plan-card"

function makePart(plan: string): ToolUIPart {
  return {
    type: "tool-exit_plan_mode",
    toolCallId: "c1",
    state: "input-available",
    input: { plan },
    output: undefined,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/PlanCard",
  component: PlanCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PlanCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    part: makePart(
      `## Refactor the MCP tool-card router

1. Extract the registry into a typed map keyed by **normalized** tool name.
2. Add a fallback to \`ToolBody\` when a card returns \`null\`.
3. Cover both ai-sdk (flat) and Anthropic (namespaced) names with \`normalizeToolName\`.

### Risks
- Plugin tools must keep routing through \`registerMessagePartRenderer\` — do not add them here.

\`\`\`ts
const Card = REGISTRY[normalizeToolName(name)]
\`\`\``
    ),
  },
}
