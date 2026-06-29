import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ChannelListBulkToolbar } from "./channel-list-bulk-toolbar"

// Toolbar shown above the channel list during a multi-selection: a count, the
// destructive delete (gated by an AlertDialog), batch pin/unpin/archive toggles,
// and a clear button.
const meta = {
  title: "Desktop/ChannelListBulkToolbar",
  component: ChannelListBulkToolbar,
  parameters: { layout: "padded" },
  args: {
    count: 3,
    onDelete: fn(),
    onPin: fn(),
    onUnpin: fn(),
    onArchive: fn(),
    onUnarchive: fn(),
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
