import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConversationOverrideDialog } from "./conversation-override-dialog"
import { makeConversationOverride } from "@/lib/storybook/fixtures/inbox"

const CONVERSATION_KEY = "slack:adapter-1:C1"

// Thin shadcn Dialog shell around `ConversationOverrideForm`. Props-only; the
// form inside derives all state from `initialRow`.
const meta = {
  title: "Inbox/ConversationOverrideDialog",
  component: ConversationOverrideDialog,
  args: {
    open: true,
    onOpenChange: fn(),
    adapterId: "adapter-1",
    conversationKey: CONVERSATION_KEY,
    sessionId: "ses_1",
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConversationOverrideDialog>

export default meta
type Story = StoryObj<typeof meta>

export const NewOverride: Story = { args: { initialRow: null } }

export const EditingExisting: Story = {
  args: {
    initialRow: makeConversationOverride({
      conversationKey: CONVERSATION_KEY,
      mode: "manual",
      pinned: true,
      allowComputerUse: true,
    }),
  },
}
