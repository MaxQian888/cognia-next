import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { LabelChip } from "./label-chip"
import type { ConversationLabelRow } from "@/lib/db/crm-types"

const label = (over: Partial<ConversationLabelRow> = {}): ConversationLabelRow => ({
  id: "lbl_1",
  name: "follow-up",
  color: "#f59e0b",
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

// Pure presentational pill — color dot + name, with an optional remove ×.
const meta = {
  title: "Inbox/LabelChip",
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
