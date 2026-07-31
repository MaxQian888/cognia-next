import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { ConversationRow, type ConversationRowItem } from "./conversation-row"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

const NOW = Date.now()

const makeItem = (over: Partial<ConversationRowItem> = {}): ConversationRowItem => ({
  session: {
    id: "ses_1",
    title: "Acme Corp · #support",
    platformBinding: { adapterId: "a1", conversationKey: "slack:a1:C1", platform: "slack" },
  } as unknown as ChatSession,
  override: undefined,
  unreadCount: 0,
  lastMessagePreview: "Thanks, that fixed it! Closing the ticket now.",
  lastMessageAt: NOW - 8 * 60 * 1000,
  ...over,
})

const override = (o: Partial<ConversationOverrideRow>): ConversationOverrideRow =>
  ({ conversationKey: "slack:a1:C1", ...o }) as ConversationOverrideRow

const meta = {
  title: "Inbox/ConversationRow",
  component: ConversationRow,
  args: { item: makeItem(), isActive: false, onSelect: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ConversationRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Active: Story = { args: { isActive: true } }

export const Unread: Story = { args: { item: makeItem({ unreadCount: 3 }) } }

export const Pinned: Story = {
  args: { item: makeItem({ override: override({ pinned: true }) }) },
}

export const PendingStatus: Story = {
  args: { item: makeItem({ override: override({ status: "pending" }) }) },
}

export const WithDraftsAndComputerUse: Story = {
  args: {
    draftCount: 2,
    item: makeItem({ unreadCount: 5, override: override({ allowComputerUse: true }) }),
  },
}

export const NoPreview: Story = {
  args: { item: makeItem({ lastMessagePreview: undefined, lastMessageAt: undefined }) },
}

/**
 * The three states side by side. `bg-muted` (active) and `bg-muted/60` (hover)
 * are near-identical, so selection now carries an accent rail, and unread
 * carries type weight rather than only the pill.
 */
export const SelectionAndUnreadContrast: Story = {
  render: (args) => (
    <div className="w-80 divide-y rounded-md border">
      <ConversationRow {...args} item={makeItem()} isActive={false} />
      <ConversationRow {...args} item={makeItem({ unreadCount: 3 })} isActive={false} />
      <ConversationRow {...args} item={makeItem()} isActive />
    </div>
  ),
}

/**
 * At the list pane's minimum width the timestamp drops out via
 * `@container/conversation-row`, leaving the title its full measure.
 */
export const NarrowRail: Story = {
  render: (args) => (
    <div className="w-48 rounded-md border">
      <ConversationRow {...args} item={makeItem({ unreadCount: 2 })} isActive={false} />
    </div>
  ),
}
