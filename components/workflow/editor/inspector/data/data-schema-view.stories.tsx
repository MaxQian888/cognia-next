import type { Meta, StoryObj } from "@storybook/nextjs"

import { DataSchemaView } from "./data-schema-view"

// Schema lens — every flattened path into the item as a draggable chip. Pure.
const meta = {
  title: "Workflow/Editor/Inspector/Data/SchemaView",
  component: DataSchemaView,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
  args: { sourceNodeId: "summarize", basePrefix: [] },
} satisfies Meta<typeof DataSchemaView>

export default meta
type Story = StoryObj<typeof meta>

// A nested payload flattens into dotted/indexed paths.
export const Nested: Story = {
  args: {
    item: {
      text: "Summary ready",
      usage: { tokens: 412, costUsd: 0.012 },
      sources: [{ url: "https://a.example" }, { url: "https://b.example" }],
    },
  },
}

// Empty item — schema-empty placeholder.
export const Empty: Story = {
  args: { item: {} },
}
