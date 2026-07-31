import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { NotificationCenter } from "./notification-center"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useNotificationStore } from "@/stores/notifications/notification-store"
import type { NotificationRecord } from "@/types/notifications"

const NOW = Date.now()

function record(over: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    id: `n_${Math.random().toString(36).slice(2)}`,
    source: "session",
    level: "info",
    title: "Agent finished a task",
    body: "Review the diff before merging.",
    createdAt: NOW - 5 * 60_000,
    updatedAt: NOW - 5 * 60_000,
    readState: "unseen",
    count: 1,
    directed: true,
    deliveredVia: ["center"],
    ...over,
  }
}

// The notification center panel (bell popover content): grouped feed, source
// filter, bulk actions, archived view, per-row triage. Reads the reactive store.
const meta = {
  title: "Notifications/NotificationCenter",
  component: NotificationCenter,
  args: { onNavigate: fn() },
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[380px] rounded-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof NotificationCenter>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
  beforeEach: () => {
    resetStore(useNotificationStore)
    seedStore(useNotificationStore, {
      hydrated: true,
      directedUnread: 2,
      ambientUnseen: 1,
      items: [
        record({ level: "error", title: "Build failed on dev" }),
        record({ source: "system", level: "warning", title: "Approval needed: deploy" }),
        record({
          source: "connector",
          directed: false,
          readState: "seen",
          title: "New inbox message",
        }),
        record({
          readState: "read",
          title: "Workflow run completed",
          createdAt: NOW - 26 * 60 * 60_000,
        }),
      ],
    })
  },
}

export const Empty: Story = {
  beforeEach: () => {
    resetStore(useNotificationStore)
    seedStore(useNotificationStore, { hydrated: true })
  },
}
