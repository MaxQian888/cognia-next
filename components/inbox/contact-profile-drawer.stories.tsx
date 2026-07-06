import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ContactProfileDrawer } from "./contact-profile-drawer"
import { seedDb } from "@/lib/storybook/seed-db"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"

const CONVERSATION_KEY = "telegram:adapter-1:u123"

// Side sheet that resolves the DM contact behind the open conversation from
// `platformIdentities` (keyed by platform + remote user id). Group chats /
// unknown contacts show the empty state.
const meta = {
  title: "Inbox/ContactProfileDrawer",
  component: ContactProfileDrawer,
  args: { open: true, onOpenChange: fn(), conversationKey: CONVERSATION_KEY },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ContactProfileDrawer>

export default meta
type Story = StoryObj<typeof meta>

// No matching identity row → empty state.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

export const KnownContact: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const identity: PlatformIdentityRow = {
        id: "pid-1",
        platform: "telegram",
        adapterId: "adapter-1",
        remoteUserId: "u123",
        displayName: "Jordan Lee",
        lastSeenAt: Date.now() - 5 * 60 * 1000,
      }
      await db.platformIdentities.put(identity)
    })
  },
}

export const MergedIdentities: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      const merged: PlatformIdentityRow = {
        id: "pid-2",
        platform: "slack",
        adapterId: "adapter-2",
        remoteUserId: "U99",
        displayName: "Jordan (Slack)",
        lastSeenAt: Date.now() - 60 * 60 * 1000,
      }
      const identity: PlatformIdentityRow = {
        id: "pid-1",
        platform: "telegram",
        adapterId: "adapter-1",
        remoteUserId: "u123",
        displayName: "Jordan Lee",
        lastSeenAt: Date.now() - 5 * 60 * 1000,
        mergedFromIds: ["pid-2"],
        mergedSnapshots: [merged],
      }
      await db.platformIdentities.put(identity)
    })
  },
}
