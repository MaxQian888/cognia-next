import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConversationActivityNotice } from "./conversation-activity-log"
import { makeAuditEntry } from "@/lib/storybook/fixtures/inbox"
import type { ConversationAssignmentEventRow } from "@/lib/db/crm-types"

const CONVERSATION_KEY = "slack:adapter-1:C1"
const now = Date.now()

// A pure presenter: it interleaves `connectorAudit` system events with the CRM
// assignment trail into one newest-first timeline and renders nothing when both
// arrive empty. `InboxNoticeArea` owns both queries and the disclosure.
const meta = {
  title: "Inbox/ConversationActivityNotice",
  component: ConversationActivityNotice,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConversationActivityNotice>

export default meta
type Story = StoryObj<typeof meta>

const assignmentEvents: ConversationAssignmentEventRow[] = [
  { id: "ae-1", conversationKey: CONVERSATION_KEY, kind: "assigned", at: now - 30_000 },
  { id: "ae-2", conversationKey: CONVERSATION_KEY, kind: "status.resolved", at: now - 10_000 },
] as ConversationAssignmentEventRow[]

export const WithActivity: Story = {
  args: {
    auditEntries: [
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
    ],
    assignmentEvents,
  },
}

// Audit rows only — no CRM trail on this conversation.
export const AuditOnly: Story = {
  args: {
    auditEntries: [
      makeAuditEntry({
        conversationKey: CONVERSATION_KEY,
        kind: "inbound.policy_blocked",
        reason: "at_mention_required",
        at: now - 5_000,
      }),
    ],
    assignmentEvents: [],
  },
}

// No activity → renders nothing.
export const Empty: Story = {
  args: { auditEntries: [], assignmentEvents: [] },
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      renders nothing when quiet → <ConversationActivityNotice {...args} />
    </div>
  ),
}
