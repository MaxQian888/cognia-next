import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ObservabilityToolbar } from "./observability-toolbar"
import { makeWindowSpans } from "@/lib/storybook/fixtures/observability"

// `ObservabilityToolbar` composes the variable filter bar, time-range picker,
// refresh selector and the edit/lock + reset-layout controls. Pure props-only.
const meta = {
  title: "Observability/Toolbar",
  component: ObservabilityToolbar,
  args: {
    preset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 10_000,
    filters: {},
    editMode: false,
    windowSpans: makeWindowSpans(),
    onPreset: fn(),
    onCustom: fn(),
    onRefreshMs: fn(),
    onFilters: fn(),
    onToggleEdit: fn(),
    onResetLayout: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[860px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ObservabilityToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Locked: Story = {}

export const EditMode: Story = {
  args: { editMode: true },
}

export const WithActiveFilters: Story = {
  args: {
    filters: { surface: ["chat"], model: ["claude-3-opus-20240229"] },
  },
}
