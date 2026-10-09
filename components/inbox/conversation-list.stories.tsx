import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConversationList } from "./conversation-list"
import { SidebarProvider } from "@/components/ui/sidebar"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useInboxLayoutStore } from "@/stores/inbox/inbox-layout-store"
import { makeConversationOverride, makeInboxSession } from "@/lib/storybook/fixtures/inbox"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"

// The list is controlled: the shell owns the rows (`useConversationRows`) and
// the URL-held grouping / filters / preview, so the stories pass them as args.
const NOW = Date.now()

const ROWS: ConversationRowItem[] = [
  {
    session: makeInboxSession({
      id: "s1",
      title: "Acme Corp · #support",
      platform: "slack",
      adapterId: "adapter-1",
      conversationKey: "slack:adapter-1:C1",
    }),
    override: undefined,
    unreadCount: 2,
    lastMessagePreview: "My order hasn't arrived yet.",
    lastMessageAt: NOW - 2 * 60 * 1000,
  },
  {
    session: makeInboxSession({
      id: "s2",
      title: "Jordan Lee (DM)",
      platform: "telegram",
      adapterId: "adapter-2",
      conversationKey: "telegram:adapter-2:u123",
    }),
    override: makeConversationOverride({
      conversationKey: "telegram:adapter-2:u123",
      status: "pending",
    }),
    unreadCount: 0,
    lastMessagePreview: "Can you reschedule for Thursday?",
    lastMessageAt: NOW - 30 * 60 * 1000,
  },
  {
    session: {
      ...makeInboxSession({
        id: "s3",
        title: "VIP · #billing",
        platform: "discord",
        adapterId: "adapter-1",
        conversationKey: "discord:adapter-1:C9",
      }),
      pinned: true,
    },
    override: undefined,
    unreadCount: 0,
    lastMessagePreview: "Invoice #4821 looks wrong.",
    lastMessageAt: NOW - 5 * 60 * 1000,
  },
  {
    session: makeInboxSession({
      id: "s4",
      title: "Old ticket",
      platform: "slack",
      adapterId: "adapter-1",
      conversationKey: "slack:adapter-1:C4",
    }),
    override: makeConversationOverride({
      conversationKey: "slack:adapter-1:C4",
      status: "resolved",
    }),
    unreadCount: 0,
    lastMessagePreview: "Thanks, closing this.",
    lastMessageAt: NOW - 26 * 60 * 60 * 1000,
  },
]

const ADAPTERS = [
  { id: "adapter-1", displayName: "Support bot", type: "slack" },
  { id: "adapter-2", displayName: "Sales bot", type: "telegram" },
]

const meta = {
  title: "Inbox/ConversationList",
  component: ConversationList,
  parameters: { layout: "fullscreen" },
  args: {
    rows: ROWS,
    adapters: ADAPTERS,
    grouping: "status",
    filters: [],
    selectionMode: "preview",
    selectedSessionId: "s1",
    onToggleFilter: fn(),
    onClearFilters: fn(),
    onSelectSession: fn(),
    onOpenSession: fn(),
  },
  beforeEach: () => {
    resetStore(useInboxLayoutStore)
  },
  decorators: [
    // The header's sidebar toggle reads the provider `InboxShell` mounts.
    (Story) => (
      <SidebarProvider className="min-h-0">
        <div className="flex h-[640px] w-80 flex-col border-r">
          <Story />
        </div>
      </SidebarProvider>
    ),
  ],
} satisfies Meta<typeof ConversationList>

export default meta
type Story = StoryObj<typeof meta>

export const ByStatus: Story = {}

export const ByAdapter: Story = { args: { grouping: "adapter" } }

export const ByPlatform: Story = { args: { grouping: "platform" } }

export const Loading: Story = { args: { rows: undefined } }

export const Empty: Story = { args: { rows: [] } }

export const Failed: Story = {
  args: { rows: undefined, error: new Error("TransactionInactiveError"), onRetry: fn() },
}

export const FilteredToUnread: Story = { args: { filters: ["unread"] } }

/** The phone: a tap opens the chat, nothing is previewed. */
export const OpenMode: Story = { args: { selectionMode: "open", selectedSessionId: null } }

/**
 * The pane can be dragged down to ~123px (`INBOX_LAYOUT_BOUNDS.listMin`), well
 * below anything `md:`/`lg:` can see. Renders the same data at that width so
 * the `@container/conversation-list` collapses — filter label, row timestamp —
 * are reviewable.
 */
export const NarrowRail: Story = {
  decorators: [
    // The header's sidebar toggle reads the provider `InboxShell` mounts.
    (Story) => (
      <SidebarProvider className="min-h-0">
        <div className="flex h-[640px] w-48 flex-col border-r">
          <Story />
        </div>
      </SidebarProvider>
    ),
  ],
}
