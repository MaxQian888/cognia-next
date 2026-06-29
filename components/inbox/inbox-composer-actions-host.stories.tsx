import type { Meta, StoryObj } from "@storybook/nextjs"

import { InboxComposerActionsHost } from "./inbox-composer-actions-host"

// Thin wrapper that mounts the `inbox.composer.actions` plugin extension slot
// with the conversation context. With no plugins contributing to the slot it
// renders nothing (`empty:hidden`) — the wrapper itself is context-free.
const meta = {
  title: "Inbox/InboxComposerActionsHost",
  component: InboxComposerActionsHost,
  args: {
    conversationKey: "slack:adapter-1:C1",
    adapterId: "adapter-1",
    platform: "slack",
    sessionId: "ses_1",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof InboxComposerActionsHost>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => (
    <div className="rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      plugin slot (empty without contributions) → <InboxComposerActionsHost {...args} />
    </div>
  ),
}
