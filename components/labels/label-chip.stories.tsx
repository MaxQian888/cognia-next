import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LabelChip } from "./label-chip"
import type { LabelRow } from "@/types/labels"

const label = (over: Partial<LabelRow> = {}): LabelRow => ({
  id: "lbl_1",
  scope: "conversation",
  name: "follow-up",
  color: "#f59e0b",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

// Pure presentational pill: colour dot + name, with an optional remove button.
// Shared by the connector inbox and the issue board, which is why it lives
// here rather than under either of them.
const meta = {
  title: "Labels/LabelChip",
  component: LabelChip,
  args: { label: label() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof LabelChip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Removable: Story = {
  args: { label: label({ id: "lbl_2", name: "vip", color: "#7c3aed" }), onRemove: fn() },
}

/** A row with no colour falls back to `defaultLabelColor(name)`, not to grey. */
export const NoColor: Story = {
  args: { label: label({ id: "lbl_3", name: "untagged", color: undefined }) },
}

export const LongName: Story = {
  args: {
    label: label({
      id: "lbl_4",
      name: "this-is-a-very-long-label-name-that-truncates",
      color: "#0ea5e9",
    }),
  },
}
