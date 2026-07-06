import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SortFilterSheet } from "./sort-filter-sheet"

// Pure props — sort/filter values + change handlers. The override dot on the
// trigger shows when either knob is off its default. Open the sheet to see the
// sort + filter radio groups.
const meta = {
  title: "Discover/SortFilterSheet",
  component: SortFilterSheet,
  args: {
    sort: "name",
    filter: "all",
    onSortChange: fn(),
    onFilterChange: fn(),
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SortFilterSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

// Non-default sort/filter → trigger shows the override badge.
export const WithOverride: Story = {
  args: { sort: "recent", filter: "installed" },
}
