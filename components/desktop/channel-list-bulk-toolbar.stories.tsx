import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChannelListBulkToolbar } from "./channel-list-bulk-toolbar"

// Bar shown above the channel list during a selection: a head row (count,
// select all / deselect all, Done) and an action row (share, move to folder,
// the read and pin switches pointed at the direction that changes something,
// archive, and delete set apart at the end behind an AlertDialog).
const meta = {
  title: "Desktop/ChannelListBulkToolbar",
  component: ChannelListBulkToolbar,
  parameters: { layout: "padded" },
  args: {
    count: 3,
    total: 12,
    onSelectAll: fn(),
    onDeselectAll: fn(),
    onMarkRead: fn(),
    onMarkUnread: fn(),
    onMoveToFolder: fn(),
    onNewFolder: fn(),
    folders: [{ id: "f1", name: "Research" } as never],
    onDelete: fn(),
    onPin: fn(),
    onUnpin: fn(),
    onArchive: fn(),
    onUnarchive: fn(),
    onShare: fn(),
    onClear: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-64 rounded-md border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChannelListBulkToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const ActiveSelection: Story = {}

export const SingleSelected: Story = { args: { count: 1 } }

export const ArchivedView: Story = { args: { archived: true, count: 5 } }

/** Selection mode just entered: the head says so, the verbs wait disabled. */
export const NothingSelectedYet: Story = { args: { count: 0 } }

/** Every row on screen is in the selection — the head offers to empty it. */
export const EverythingSelected: Story = { args: { count: 12 } }

/** An all-pinned, all-read selection flips both switches the other way. */
export const PinnedAndRead: Story = {
  args: { allPinned: true, anyUnread: false, anyInFolder: true },
}
