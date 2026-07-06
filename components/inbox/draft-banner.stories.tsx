import type { Meta, StoryObj } from "@storybook/nextjs"

import { DraftBanner } from "./draft-banner"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeConnectorDraft } from "@/lib/storybook/fixtures/inbox"

const CONVERSATION_KEY = "story:conversation"

// `DraftBanner` subscribes to pending `connectorDrafts` for its conversationKey
// via `useLiveQuery`, and renders `null` when none exist. Seed the DB so the
// banner appears; the EmptyState story seeds nothing to show the null branch.
const meta = {
  title: "Inbox/DraftBanner",
  component: DraftBanner,
  args: { conversationKey: CONVERSATION_KEY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof DraftBanner>

export default meta
type Story = StoryObj<typeof meta>

export const Pending: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.connectorDrafts.bulkPut([
        makeConnectorDraft({ conversationKey: CONVERSATION_KEY, status: "pending" }),
      ])
    })
  },
}

export const NoDraft: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
