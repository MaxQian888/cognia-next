import type { Meta, StoryObj } from "@storybook/nextjs"

import { DraftCenter } from "./draft-center"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeConnectorDraft } from "@/lib/storybook/fixtures/inbox"

// Cross-conversation queue of pending `ConnectorDraftRow`s grouped by
// conversation, each reusing `<DraftEditor />`. Shows an empty state when no
// drafts are pending. Seed pending drafts to render the grouped queue.
const meta = {
  title: "Inbox/DraftCenter",
  component: DraftCenter,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] flex-col">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DraftCenter>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const WithDrafts: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorDrafts.bulkPut([
        makeConnectorDraft({
          conversationKey: "telegram:adapter-1:1001",
          status: "pending",
          segments: [{ type: "text", text: "Sure, I can reschedule that for Thursday." }],
        }),
        makeConnectorDraft({
          conversationKey: "telegram:adapter-1:1001",
          status: "pending",
          segments: [{ type: "text", text: "Follow-up: confirming the new time works." }],
        }),
        makeConnectorDraft({
          conversationKey: "slack:adapter-2:C42",
          status: "pending",
          segments: [{ type: "text", text: "Thanks — closing this ticket now." }],
        }),
      ])
    })
  },
}
