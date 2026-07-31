import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { AssigneeChip } from "./assignee-chip"
import type { ConversationAssignee } from "@/lib/db/conversation-overrides"

const meta = {
  title: "Inbox/AssigneeChip",
  component: AssigneeChip,
  args: { conversationKey: "slack:a1:C1", sessionId: "ses_1" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof AssigneeChip>

export default meta
type Story = StoryObj<typeof meta>

export const Unassigned: Story = { args: { assignee: undefined } }

export const Me: Story = { args: { assignee: { kind: "human" } as ConversationAssignee } }

export const Character: Story = {
  args: { assignee: { kind: "character", label: "Ada" } as ConversationAssignee },
}

export const Team: Story = {
  args: { assignee: { kind: "team", label: "Support" } as ConversationAssignee },
}
