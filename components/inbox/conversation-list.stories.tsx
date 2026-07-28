import type { Meta, StoryObj } from "@storybook/nextjs"

import { ConversationList } from "./conversation-list"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useProjectStore } from "@/stores/project/project-store"
import {
  makeConversationOverride,
  makeInboxMessage,
  makeInboxSession,
} from "@/lib/storybook/fixtures/inbox"

// Enriches every platform-bound session with its latest message + unread count
// and buckets pinned / active / archived. Reads sessions + overrides + messages
// from Dexie and the active project from the project store. Seed sessions +
// messages to render the list; the empty DB shows the empty state.
const meta = {
  title: "Inbox/ConversationList",
  component: ConversationList,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useProjectStore)
  },
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-80 flex-col border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ConversationList>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

/**
 * The pane can be dragged down to ~123px (`INBOX_LAYOUT_BOUNDS.listMin`), well
 * below anything `md:`/`lg:` can see. Renders the same data at that width so
 * the `@container/conversation-list` collapses — filter label, row timestamp —
 * are reviewable.
 */
export const NarrowRail: Story = {
  decorators: [
    (Story) => (
      <div className="flex h-[640px] w-48 flex-col border-r">
        <Story />
      </div>
    ),
  ],
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.sessions.bulkPut([
        makeInboxSession({
          id: "s1",
          title: "Acme Corp · #support",
          platform: "slack",
          conversationKey: "slack:adapter-1:C1",
        }),
      ])
      await db.messages.bulkPut([
        makeInboxMessage({
          id: "m1",
          sessionId: "s1",
          parts: [{ type: "text", text: "My order hasn't arrived yet." }],
          createdAt: Date.now() - 8 * 60 * 1000,
        }),
      ])
    })
  },
}

export const WithConversations: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const s1 = makeInboxSession({
        id: "s1",
        title: "Acme Corp · #support",
        platform: "slack",
        conversationKey: "slack:adapter-1:C1",
      })
      const s2 = makeInboxSession({
        id: "s2",
        title: "Jordan Lee (DM)",
        platform: "telegram",
        conversationKey: "telegram:adapter-1:u123",
      })
      const s3 = makeInboxSession({
        id: "s3",
        title: "VIP · #billing",
        platform: "discord",
        conversationKey: "discord:adapter-1:C9",
      })
      await db.sessions.bulkPut([s1, s2, s3])
      await db.conversationOverrides.bulkPut([
        makeConversationOverride({ conversationKey: "discord:adapter-1:C9", pinned: true }),
      ])
      await db.messages.bulkPut([
        makeInboxMessage({
          id: "m1",
          sessionId: "s1",
          parts: [{ type: "text", text: "My order hasn't arrived yet." }],
          createdAt: Date.now() - 2 * 60 * 1000,
        }),
        makeInboxMessage({
          id: "m2",
          sessionId: "s2",
          parts: [{ type: "text", text: "Can you reschedule for Thursday?" }],
          createdAt: Date.now() - 30 * 60 * 1000,
        }),
        makeInboxMessage({
          id: "m3",
          sessionId: "s3",
          parts: [{ type: "text", text: "Invoice #4821 looks wrong." }],
          createdAt: Date.now() - 5 * 60 * 1000,
        }),
      ])
    })
  },
}
