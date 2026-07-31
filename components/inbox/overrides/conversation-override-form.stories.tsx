import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConversationOverrideForm } from "./conversation-override-form"
import { makeConversationOverride } from "@/lib/storybook/fixtures/inbox"

const CONVERSATION_KEY = "slack:adapter-1:C1"

// All form state derives from `initialRow` props, so the editor renders fully
// without DB seeding. Save / Delete / Apply-to-adapter write to Dexie on click.
const meta = {
  title: "Inbox/ConversationOverrideForm",
  component: ConversationOverrideForm,
  args: {
    adapterId: "adapter-1",
    conversationKey: CONVERSATION_KEY,
    sessionId: "ses_1",
    onDone: fn(),
    onCancel: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-lg">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConversationOverrideForm>

export default meta
type Story = StoryObj<typeof meta>

// No existing row → creating a fresh override (no Delete button).
export const NewOverride: Story = { args: { initialRow: null } }

// Editing an existing override prefills every field and shows Delete.
export const EditingExisting: Story = {
  args: {
    initialRow: makeConversationOverride({
      conversationKey: CONVERSATION_KEY,
      mode: "draft",
      characterId: "char-support",
      allowComputerUse: true,
      providerOverride: "codex",
      modelOverride: "gpt-5",
      pinned: true,
      slaResponseMinutes: 30,
      quietHours: { from: "22:00", to: "08:00", tz: "Asia/Shanghai" },
    }),
  },
}
