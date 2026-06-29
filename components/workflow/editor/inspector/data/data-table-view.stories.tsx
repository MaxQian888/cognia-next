import type { Meta, StoryObj } from "@storybook/nextjs"

import { DataTableView } from "./data-table-view"

// Table lens over one item — key / type / value rows, each a drag source for an
// expression reference. Pure props.
const meta = {
  title: "Workflow/Editor/Inspector/Data/TableView",
  component: DataTableView,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[420px]">{Story()}</div>],
  args: { sourceNodeId: "summarize", basePrefix: [] },
} satisfies Meta<typeof DataTableView>

export default meta
type Story = StoryObj<typeof meta>

// Object item — one row per field.
export const ObjectItem: Story = {
  args: {
    item: { text: "Summary ready", tokens: 412, model: "claude-sonnet-4", cached: true },
  },
}

// Array item paged from index 1 — basePrefix carries the array index.
export const ArrayItemPaged: Story = {
  args: { item: { name: "Ada", role: "researcher" }, basePrefix: [1] },
}

// Empty object.
export const EmptyObject: Story = {
  args: { item: {} },
}

// Non-object item renders a single draggable value row.
export const PrimitiveItem: Story = {
  args: { item: 42 },
}
