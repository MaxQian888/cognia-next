import type { Meta, StoryObj } from "@storybook/nextjs"
import type { ToolUIPart } from "ai"

import { WikiReadCard } from "./wiki-read-card"

function makePart(output: unknown): ToolUIPart {
  return {
    type: "tool-wiki_read",
    toolCallId: "c1",
    state: "output-available",
    input: { slug: "ops/deploy-runbook" },
    output,
  } as unknown as ToolUIPart
}

const meta = {
  title: "Chat/MCP/WikiReadCard",
  component: WikiReadCard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof WikiReadCard>

export default meta
type Story = StoryObj<typeof meta>

export const Sections: Story = {
  args: {
    part: makePart({
      slug: "ops/deploy-runbook",
      title: "Production Deployment Runbook",
      sections: [
        {
          heading: "Prerequisites",
          body: "- Green CI on `main`\n- Migration gate **passing**\n- On-call acknowledged",
        },
        {
          heading: "Rollout",
          body: "1. Cut a release tag\n2. Promote the canary\n3. Watch error rate for 10 minutes\n4. Promote to the full fleet",
        },
      ],
    }),
  },
}

export const FallbackBody: Story = {
  args: {
    part: makePart({
      slug: "ops/oncall",
      title: "On-call Expectations",
      body: "Acknowledge pages within **5 minutes**. Escalate to the secondary if you cannot start triage in 15 minutes.",
    }),
  },
}
