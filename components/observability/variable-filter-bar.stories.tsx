import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { VariableFilterBar } from "./variable-filter-bar"
import { makeWindowSpans } from "@/lib/storybook/fixtures/observability"

// `VariableFilterBar` renders one multi-select per filterable dimension; options
// are derived from the windowed spans. Pure props-only. Stories show no
// selection vs an active multi-dimension filter.
const meta = {
  title: "Observability/VariableFilterBar",
  component: VariableFilterBar,
  args: {
    windowSpans: makeWindowSpans(),
    filters: {},
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[640px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VariableFilterBar>

export default meta
type Story = StoryObj<typeof meta>

export const NoFilters: Story = {}

export const WithActiveFilters: Story = {
  args: {
    filters: {
      model: ["gpt-4o-2024-08-06"],
      surface: ["chat", "workflow"],
    },
  },
}

export const EmptyWindow: Story = {
  args: { windowSpans: [] },
}
