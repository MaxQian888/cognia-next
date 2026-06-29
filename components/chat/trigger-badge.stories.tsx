import type { Meta, StoryObj } from "@storybook/nextjs"

import { TriggerBadge } from "./trigger-badge"
import {
  clearAllTriggerAudit,
  recordTriggerAuditEntry,
  type TriggerAuditStatus,
} from "@/lib/chat/trigger-audit-ring"

// Small pill rendered next to a chat message when workflow triggers fired on
// its arrival. Data comes from the in-memory trigger-audit ring; renders
// nothing when no trigger fired for the (sessionId, messageId) pair.
const SID = "demo-session"
const MID = "msg-1"

const entry = (over: {
  kind: string
  status: TriggerAuditStatus
  workflowId: string
  errorMessage?: string
}) => ({
  sessionId: SID,
  messageId: MID,
  pluginId: null,
  ...over,
})

const seed = (entries: Parameters<typeof recordTriggerAuditEntry>[0][]) => () => {
  clearAllTriggerAudit()
  for (const e of entries) recordTriggerAuditEntry(e)
}

const meta = {
  title: "Chat/TriggerBadge",
  component: TriggerBadge,
  parameters: { layout: "centered" },
  args: { sessionId: SID, messageId: MID },
  beforeEach: seed([
    entry({ kind: "trigger.chat.message", status: "dispatched", workflowId: "wf-summarize" }),
  ]),
} satisfies Meta<typeof TriggerBadge>

export default meta
type Story = StoryObj<typeof meta>

/** One dispatched trigger. Click the pill for the workflow list. */
export const SingleTrigger: Story = {}

/** Several triggers with mixed statuses. */
export const MixedStatuses: Story = {
  beforeEach: seed([
    entry({ kind: "trigger.chat.message", status: "dispatched", workflowId: "wf-summarize" }),
    entry({ kind: "trigger.github.issue", status: "rejected", workflowId: "wf-triage" }),
    entry({
      kind: "trigger.slack.mention",
      status: "error",
      workflowId: "wf-notify",
      errorMessage: "Webhook returned 500",
    }),
  ]),
}

/** No triggers fired → the badge renders nothing. */
export const NoTriggers: Story = {
  beforeEach: seed([]),
}
