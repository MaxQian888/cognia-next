import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryRow } from "./memory-row"
import { makeMemory, MEMORY_NOW } from "@/lib/storybook/fixtures/memory"

// One memory in the `/memory` panel: display + inline edit + pin + delete. All
// mutation callbacks are mocked with `fn()`.
const meta = {
  title: "Memory/MemoryRow",
  component: MemoryRow,
  args: {
    memory: makeMemory({ sourceSessionId: "ses_1" }),
    onPinToggle: fn(),
    onSave: fn(),
    onDelete: fn(),
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[32rem]">
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

export const Invalidated: Story = {
  args: {
    memory: makeMemory({ status: "invalidated", invalidatedAt: MEMORY_NOW, type: "episodic" }),
  },
}
