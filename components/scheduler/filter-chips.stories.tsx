import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { FilterChips } from "./filter-chips"

// `FilterChips` is a pure single-select chip row with optional per-chip counts.
const meta = {
  title: "Scheduler/FilterChips",
  component: FilterChips,
  parameters: { layout: "centered" },
  args: {
    onFilterChange: fn(),
  },
} satisfies Meta<typeof FilterChips>

export default meta
type Story = StoryObj<typeof meta>

const STATUS_FILTERS = [
  { key: "all", label: "All", count: 12 },
  { key: "active", label: "Active", count: 8 },
  { key: "paused", label: "Paused", count: 4 },
  { key: "error", label: "Error", count: 0 },
]

export const Default: Story = {
  args: {
    filters: STATUS_FILTERS,
    activeFilter: "all",
  },
}

export const SecondActive: Story = {
  args: {
    filters: STATUS_FILTERS,
    activeFilter: "active",
  },
}

export const NoCounts: Story = {
  args: {
    filters: [
      { key: "all", label: "All" },
      { key: "chat", label: "Chat" },
      { key: "workflow", label: "Workflow" },
    ],
    activeFilter: "chat",
  },
}
