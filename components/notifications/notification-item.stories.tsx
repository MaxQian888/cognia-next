import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { NotificationItem } from "./notification-item"
import {
  NOTIFICATION_LEVELS,
  NOTIFICATION_SOURCES,
  type NotificationRecord,
} from "@/types/notifications"

const NOW = Date.now()

const baseRecord = (over: Partial<NotificationRecord> = {}): NotificationRecord => ({
  id: "n1",
  source: "session",
  level: "info",
  title: "Agent finished refactoring the renderer",
  body: "12 files changed, 3 tests added. Review the diff before merging.",
  createdAt: NOW - 5 * 60 * 1000,
  updatedAt: NOW - 5 * 60 * 1000,
  readState: "unseen",
  count: 1,
  directed: true,
  deliveredVia: ["center"],
  ...over,
})

const meta = {
  title: "Notifications/NotificationItem",
  component: NotificationItem,
  args: {
    record: baseRecord(),
    onOpen: fn(),
    onMarkRead: fn(),
    onMarkDone: fn(),
    onSnooze: fn(),
    onRemove: fn(),
    onAction: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof NotificationItem>

export default meta
type Story = StoryObj<typeof meta>

export const UnreadDirected: Story = {
  args: {
    record: baseRecord({
      level: "error",
      directed: true,
      actions: [{ id: "a1", label: "Review", command: "open.diff", variant: "primary" }],
    }),
  },
}

export const ReadAmbient: Story = {
  args: { record: baseRecord({ readState: "read", directed: false }) },
}

export const Coalesced: Story = {
  args: { record: baseRecord({ count: 4, level: "success" }) },
}

export const TwoInlineActions: Story = {
  args: {
    record: baseRecord({
      level: "warning",
      actions: [
        { id: "a1", label: "Approve", command: "approve", variant: "primary" },
        { id: "a2", label: "Dismiss", command: "dismiss", variant: "secondary" },
      ],
    }),
  },
}

export const MenuAlwaysVisible: Story = {
  args: { menuAlwaysVisible: true, record: baseRecord({ readState: "read" }) },
}

export const AllSources: Story = {
  render: (args) => (
    <div className="divide-y rounded-md border">
      {NOTIFICATION_SOURCES.map((source) => (
        <NotificationItem
          key={source}
          {...args}
          record={baseRecord({ id: source, source, title: `Update from ${source}` })}
        />
      ))}
    </div>
  ),
}

export const AllLevels: Story = {
  render: (args) => (
    <div className="divide-y rounded-md border">
      {NOTIFICATION_LEVELS.map((level) => (
        <NotificationItem
          key={level}
          {...args}
          record={baseRecord({ id: level, level, title: `A ${level}-level notification` })}
        />
      ))}
    </div>
  ),
}
