import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AgentTeamChat } from "./chat"
import { buildMentionableTargets } from "@/lib/agent-team/runtime-targets"
import { buildTeammate } from "@/lib/storybook/fixtures/agent-team"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

const mentionables = buildMentionableTargets([
  buildTeammate({ id: "tm-coder", name: "Coder", role: "teammate", config: { runtime: "codex" } }),
])

const messages: AgentTeamMessage[] = [
  {
    id: "m1",
    teamId: "team-1",
    type: "direct",
    senderId: "__user__",
    senderName: "You",
    content: "@Coder please fix the reducer off-by-one.",
    read: true,
    timestamp: new Date("2026-06-29T10:00:00.000Z"),
  },
  {
    id: "m2",
    teamId: "team-1",
    type: "result_share",
    senderId: "tm-coder",
    senderName: "Coder",
    content: "Patched `computePlanCounts` and the suite is green.",
    read: true,
    timestamp: new Date("2026-06-29T10:02:00.000Z"),
  },
]

const meta = {
  title: "Agent/Workspace/Chat",
  component: AgentTeamChat,
  parameters: { layout: "fullscreen" },
  // The chat is designed to fill a bounded flex column (message list grows,
  // composer pinned at the bottom). Give it a full-height parent so the
  // preview matches how the workspace tab mounts it.
  decorators: [
    (Story) => (
      <div className="flex h-screen flex-col p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    className: "min-h-0 flex-1",
    teamId: "team-1",
    messages,
    mentionables,
    onSend: fn(),
    onStop: fn(),
    onRetry: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof AgentTeamChat>

export default meta
type Story = StoryObj<typeof meta>

// Message list + composer + mention chips.
export const WithMessages: Story = {}

export const Streaming: Story = {
  args: { isSending: true },
}

// No messages → empty state + composer hint.
export const Empty: Story = {
  args: { messages: [] },
}
