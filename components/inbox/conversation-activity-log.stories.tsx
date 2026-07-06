import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConversationActivityLog } from "./conversation-activity-log"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeAuditEntry } from "@/lib/storybook/fixtures/inbox"

const CONVERSATION_KEY = "slack:adapter-1:C1"

// Interleaves `connectorAudit` system events with the CRM assignment trail for
// one conversation; renders nothing when both are empty. Seed both tables so
// the collapsible timeline appears.
const meta = {
  title: "Inbox/ConversationActivityLog",
  component: ConversationActivityLog,
  args: { conversationKey: CONVERSATION_KEY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConversationActivityLog>

export default meta
type Story = StoryObj<typeof meta>

export const WithActivity: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const now = Date.now()
      await db.connectorAudit.bulkPut([
        makeAuditEntry({
          conversationKey: CONVERSATION_KEY,
          kind: "inbound.edited",
          at: now - 60_000,
        }),
        makeAuditEntry({
          conversationKey: CONVERSATION_KEY,
          kind: "override.computer_use_changed",
          at: now - 120_000,
        }),
        makeAuditEntry({
          conversationKey: CONVERSATION_KEY,
          kind: "inbound.welcome_sent",
          at: now - 180_000,
        }),
      ])
      await db.conversationAssignmentEvents.bulkPut([
        { id: "ae-1", conversationKey: CONVERSATION_KEY, kind: "assigned", at: now - 30_000 },
        {
          id: "ae-2",
          conversationKey: CONVERSATION_KEY,
          kind: "status.resolved",
          at: now - 10_000,
        },
      ])
    })
  },
}

// No activity → renders nothing.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when quiet → <ConversationActivityLog {...args} />
    </div>
  ),
}
