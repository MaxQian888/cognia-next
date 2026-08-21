import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryRow } from "./memory-row"
import { makeMemory, MEMORY_NOW } from "@/lib/storybook/fixtures/memory"

// One memory in the `/memory` list. Actions are revealed on hover / focus, so
// the resting state is deliberately quiet — hover a row to see pin, edit,
// archive and the overflow menu. All mutation callbacks are mocked with `fn()`.
const meta = {
  title: "Memory/MemoryRow",
  component: MemoryRow,
  args: {
    memory: makeMemory({ sourceSessionId: "ses_1" }),
    onPinToggle: fn(),
    onSave: fn(),
    onArchive: fn(),
    onDelete: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[32rem] rounded-lg border">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MemoryRow>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Pinned: Story = {
  args: { memory: makeMemory({ pinned: true, type: "procedural", importance: 9 }) },
}

export const Compact: Story = {
  args: { density: "compact" },
}

export const WithTags: Story = {
  args: {
    memory: makeMemory({ tags: ["tools", "cli", "preferences", "workflow", "editor"] }),
    onTagClick: fn(),
  },
}

/** Only states that need attention render a governance badge. */
export const Conflicting: Story = {
  args: { memory: makeMemory({ reviewStatus: "conflict" }) },
}

/** ADR-0115 §7 keeps these out of recall until a human promotes them. */
export const AwaitingReview: Story = {
  args: { memory: makeMemory({ reviewStatus: "pending_instruction" }) },
}

export const Archived: Story = {
  args: {
    memory: makeMemory({ status: "invalidated", invalidatedAt: MEMORY_NOW, type: "episodic" }),
  },
}

export const Selected: Story = {
  args: { selectable: true, selected: true, active: true, onSelectToggle: fn() },
}
