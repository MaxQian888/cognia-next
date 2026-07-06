import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MessageActionsMenu } from "./message-actions-menu"
import { TEAM_MESSAGE_METADATA_KEYS } from "@/lib/agent-team/team-runtime-dispatcher"
import type { AgentTeamMessage } from "@/types/agent/agent-team"

const baseMessage: AgentTeamMessage = {
  id: "msg-1",
  teamId: "team-1",
  type: "direct",
  senderId: "tm-coder",
  senderName: "Coder",
  content: "Patched the reducer and re-ran the suite — all green.",
  read: true,
  timestamp: new Date("2026-06-29T10:05:00.000Z"),
  metadata: {
    [TEAM_MESSAGE_METADATA_KEYS.DISPATCH_TARGET_ID]: "tm-coder",
    [TEAM_MESSAGE_METADATA_KEYS.DISPATCH_PROMPT]: "Fix the reducer off-by-one",
  },
}

const meta = {
  title: "Agent/Workspace/MessageActionsMenu",
  component: MessageActionsMenu,
  args: {
    message: baseMessage,
    onRetry: fn(),
    onDelete: fn(),
  },
} satisfies Meta<typeof MessageActionsMenu>

export default meta
type Story = StoryObj<typeof meta>

// Teammate message with dispatch metadata → copy + retry + delete.
export const FullActions: Story = {}

// User message (no dispatch metadata) → retry hidden.
export const UserMessage: Story = {
  args: {
    message: { ...baseMessage, senderId: "__user__", senderName: "You", metadata: undefined },
  },
}

// No delete handler → copy only.
export const CopyOnly: Story = {
  args: { onDelete: undefined, onRetry: undefined },
}
