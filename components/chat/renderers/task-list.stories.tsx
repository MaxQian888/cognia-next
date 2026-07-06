import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskList } from "./task-list"

const ITEMS = [
  { id: "1", text: "Research existing implementation", checked: true },
  { id: "2", text: "Write a failing repro test", checked: true },
  {
    id: "3",
    text: "Implement the fix",
    checked: false,
    children: [
      { id: "3a", text: "Patch the redaction gate", checked: false },
      { id: "3b", text: "Wire it into build-options", checked: false },
    ],
  },
  { id: "4", text: "Run pnpm test:coverage", checked: false },
]

const meta = {
  title: "Chat/Renderers/TaskList",
  component: TaskList,
  parameters: { layout: "padded" },
  args: { items: ITEMS, onToggle: fn() },
} satisfies Meta<typeof TaskList>

export default meta
type Story = StoryObj<typeof meta>

// Read-only checklist with nested sub-tasks.
export const Default: Story = {}

// Progress bar summarising completed / total across the flattened tree.
export const WithProgress: Story = {
  args: { showProgress: true },
}

// Interactive — rows are clickable and fire onToggle.
export const Interactive: Story = {
  args: { interactive: true, showProgress: true },
}

// Circle glyph variant instead of square checkboxes.
export const CircleVariant: Story = {
  args: { variant: "circle", showProgress: true },
}
