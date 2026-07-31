import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"
import { ArchiveIcon, Trash2Icon } from "lucide-react"

import { SwipeRow } from "./swipe-row"

function Row({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <span className="size-8 shrink-0 rounded-full bg-muted" />
      <span className="flex-1 truncate">{label}</span>
    </div>
  )
}

// Horizontal swipe-to-reveal row. Drag the foreground left/right to expose the
// action buttons (also visible behind the row in Storybook).
const meta = {
  title: "Interactions/SwipeRow",
  component: SwipeRow,
  args: { silent: true },
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[400px] border-y">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SwipeRow>

export default meta
type Story = StoryObj<typeof meta>

export const RightActions: Story = {
  args: {
    rightActions: [
      {
        id: "archive",
        label: "Archive",
        icon: <ArchiveIcon className="size-4" />,
        onSelect: fn(),
      },
      {
        id: "delete",
        label: "Delete",
        icon: <Trash2Icon className="size-4" />,
        destructive: true,
        onSelect: fn(),
      },
    ],
    children: <Row label="Swipe me left to reveal actions" />,
  },
}

export const BothSides: Story = {
  args: {
    leftActions: [{ id: "pin", label: "Pin", onSelect: fn() }],
    rightActions: [{ id: "delete", label: "Delete", destructive: true, onSelect: fn() }],
    children: <Row label="Swipe either direction" />,
  },
}
