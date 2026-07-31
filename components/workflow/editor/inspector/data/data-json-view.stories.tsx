import type { Meta, StoryObj } from "@storybook/nextjs"

import { DataJsonView } from "./data-json-view"

// Pretty-printed JSON lens over a single NDV item. Pure — takes one `item`.
const meta = {
  title: "Workflow/Editor/Inspector/Data/JsonView",
  component: DataJsonView,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
} satisfies Meta<typeof DataJsonView>

export default meta
type Story = StoryObj<typeof meta>

// A nested object payload.
export const Object: Story = {
  args: {
    item: {
      id: "msg_123",
      text: "Three updates since yesterday.",
      tokens: 412,
      meta: { model: "claude-sonnet-4", cached: true },
    },
  },
}

// A primitive value.
export const Primitive: Story = {
  args: { item: "Here is the summary." },
}

// Null / no value.
export const Null: Story = {
  args: { item: null },
}
