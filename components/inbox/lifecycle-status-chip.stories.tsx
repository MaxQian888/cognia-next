import type { Meta, StoryObj } from "@storybook/nextjs"

import { LifecycleStatusChip } from "./lifecycle-status-chip"

// Status comes purely from props; the dropdown writes via `setStatus` (Dexie)
// on click. Each story fixes a different current status so all four dot colors
// + labels are visible.
const meta = {
  title: "Inbox/LifecycleStatusChip",
  component: LifecycleStatusChip,
  args: { conversationKey: "slack:a1:C1", sessionId: "ses_1", status: "open" },
  parameters: { layout: "padded" },
} satisfies Meta<typeof LifecycleStatusChip>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const Pending: Story = { args: { status: "pending" } }

export const Snoozed: Story = { args: { status: "snoozed" } }

export const Resolved: Story = { args: { status: "resolved" } }
