import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { MemoryFilterToolbar, EMPTY_MEMORY_FILTER } from "./memory-filter-toolbar"

const writers = [
  { id: "tm-lead", name: "Lead" },
  { id: "tm-coder", name: "Coder" },
]

const meta = {
  title: "Agent/Workspace/Settings/MemoryFilterToolbar",
  component: MemoryFilterToolbar,
  args: {
    filter: EMPTY_MEMORY_FILTER,
    onChange: fn(),
    writers,
    availableTags: ["decision", "blocker", "context"],
  },
} satisfies Meta<typeof MemoryFilterToolbar>

export default meta
type Story = StoryObj<typeof meta>

// No active criteria → reset button hidden.
export const Default: Story = {}

// Active filter → reset button shown.
export const Active: Story = {
  args: {
    filter: { writerId: "tm-coder", tag: "decision", text: "reducer" },
  },
}
