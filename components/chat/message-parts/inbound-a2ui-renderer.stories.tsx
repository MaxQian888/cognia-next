import type { Meta, StoryObj } from "@storybook/nextjs"
import type { InboundA2UIBlock } from "@/lib/connectors/adapters/_shared/inbound-a2ui-types"

import { InboundA2UIRenderer } from "./inbound-a2ui-renderer"

// A rich Slack-style block: heading, text, a divider, a list, and an action row.
const slackBlock: InboundA2UIBlock = {
  v: 1,
  source: "slack",
  title: "Deploy approval",
  body: [
    { kind: "heading", level: 1, text: "Production deploy #482" },
    { kind: "text", text: "Ada requested approval to ship the routing fix." },
    { kind: "divider" },
    {
      kind: "list",
      ordered: true,
      children: [
        { kind: "text", text: "12 files changed" },
        { kind: "text", text: "All checks green" },
      ],
    },
    {
      kind: "row",
      children: [
        { kind: "button", label: "Approve", style: "primary", actionId: "approve_deploy" },
        { kind: "button", label: "Reject", style: "danger", actionId: "reject_deploy" },
        { kind: "link", href: "https://example.com/pr/482", label: "View PR" },
      ],
    },
  ],
}

// A Lark card with alert + mention + reply context, plus an unrecognised raw payload.
const larkBlock: InboundA2UIBlock = {
  v: 1,
  source: "lark",
  body: [
    { kind: "reply_context", replyToMessageId: "om_123", preview: "Can someone look at this?" },
    {
      kind: "card",
      title: "Incident #17",
      subtitle: "Severity: high",
      children: [
        {
          kind: "alert",
          tone: "warning",
          children: [{ kind: "text", text: "API latency above SLO for 12 minutes." }],
        },
        {
          kind: "row",
          children: [
            { kind: "text", text: "Owner:", emphasis: "muted" },
            { kind: "mention", handle: "U999", resolved: "On-call" },
          ],
        },
      ],
    },
  ],
  raw: { blocks: [{ type: "interactive", elements: 3 }] },
}

const meta = {
  title: "Chat/MessageParts/InboundA2UIRenderer",
  component: InboundA2UIRenderer,
  parameters: { layout: "padded" },
} satisfies Meta<typeof InboundA2UIRenderer>

export default meta
type Story = StoryObj<typeof meta>

export const SlackBlock: Story = {
  args: { block: slackBlock },
}

export const LarkCardWithRaw: Story = {
  args: { block: larkBlock },
}

// Minimal block — just plain text and the source chip.
export const Minimal: Story = {
  args: {
    block: {
      v: 1,
      source: "discord",
      body: [{ kind: "text", text: "A plain inbound message with no interactive elements." }],
    },
  },
}
