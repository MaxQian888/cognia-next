import type { Meta, StoryObj } from "@storybook/nextjs"

import { NotificationBell } from "./notification-bell"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useNotificationStore } from "@/stores/notifications/notification-store"
import type { NotificationRecord } from "@/types/notifications"

const NOW = Date.now()

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: `n_${Math.random().toString(36).slice(2)}`,
    source: "session",
    level: "info",
    title: "Agent finished refactoring the renderer",
    body: "12 files changed, 3 tests added.",
    createdAt: NOW - 5 * 60_000,
    updatedAt: NOW - 5 * 60_000,
    readState: "unseen",
    count: 1,
    directed: true,
    deliveredVia: ["center"],
    ...over,
  }
}

function seed(items: NotificationRecord[], directedUnread: number, ambientUnseen: number) {
  resetStore(useNotificationStore)
  seedStore(useNotificationStore, { items, hydrated: true, directedUnread, ambientUnseen })
}

// Status-bar bell with a two-tier badge: a numeric red badge for "directed at
// you" unread, a plain dot for ambient activity. Opens the notification center.
const meta = {
  title: "Notifications/NotificationBell",
  component: NotificationBell,
  parameters: { layout: "centered" },
} satisfies Meta<typeof NotificationBell>

export default meta
type Story = StoryObj<typeof meta>

export const DirectedUnread: Story = {
  beforeEach: () => seed([record(), record({ level: "error" })], 2, 0),
}

export const AmbientOnly: Story = {
  beforeEach: () => seed([record({ directed: false, readState: "seen" })], 0, 3),
}

export const Quiet: Story = {
  beforeEach: () => seed([], 0, 0),
}
