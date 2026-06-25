import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { WikiSearchCard } from "./wiki-search-card"

function makePart(output: unknown): ToolUIPart {
  return {
    type: "tool-wiki_search",
    toolCallId: "c1",
    state: "output-available",
    input: { query: "deployment runbook" },
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/WikiSearchCard",
  component: WikiSearchCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WikiSearchCard>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    part: makePart({
      hits: [
        {
          slug: "ops/deploy-runbook",
          title: "Production Deployment Runbook",
          score: 0.94,
          excerpt:
            "Step-by-step rollout: cut a release tag, run the migration gate, then promote the canary before the full fleet.",
        },
        {
          slug: "ops/rollback",
          title: "Emergency Rollback Procedure",
          score: 0.81,
          excerpt:
            "Pin the previous build, drain in-flight sessions, and re-point the load balancer.",
        },
      ],
    }),
  },
}

export const NoResults: Story = {
  args: { part: makePart({ hits: [] }) },
}
