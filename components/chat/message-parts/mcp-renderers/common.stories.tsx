import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpCardShell } from "./common"

// McpCardShell is the shared chrome (titled header + optional badge + body)
// every structured MCP / built-in tool card wraps its content in.
const meta = {
  title: "Chat/MessageParts/McpRenderers/McpCardShell",
  component: McpCardShell,
  parameters: { layout: "padded" },
  args: {
    title: "Read",
    testId: "story-card-shell",
    children: <p className="text-muted-foreground">app/page.tsx · 42 lines</p>,
  },
} satisfies Meta<typeof McpCardShell>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// With a badge in the header (e.g. a host, count, or status).
export const WithBadge: Story = {
  args: { title: "WebFetch", badge: "nextjs.org" },
}

// Multi-line body content.
export const RichBody: Story = {
  args: {
    title: "Grep",
    badge: "3 matches",
    children: (
      <ul className="space-y-0.5 font-mono">
        <li>components/chat/chat-view.tsx:9</li>
        <li>components/chat/message-list.tsx:42</li>
        <li>stores/chat/index.ts:120</li>
      </ul>
    ),
  },
}
