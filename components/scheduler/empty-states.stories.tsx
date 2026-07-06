import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { TaskListEmptyState, PanelErrorState } from "./empty-states"

// `empty-states.tsx` ships two pure presentational fallbacks:
// `TaskListEmptyState` (empty vs filtered variants) and `PanelErrorState`
// (panel-level error boundary fallback). The meta targets the empty-state
// component; the error-state stories render `PanelErrorState` directly.
const meta = {
  title: "Scheduler/EmptyStates",
  component: TaskListEmptyState,
  parameters: { layout: "centered" },
  args: {
    onCreate: fn(),
    onClearFilters: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskListEmptyState>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: {
    variant: "empty",
  },
}

export const EmptyNoCta: Story = {
  args: {
    variant: "empty",
    onCreate: undefined,
  },
}

export const Filtered: Story = {
  args: {
    variant: "filtered",
  },
}

export const FilteredNoCta: Story = {
  args: {
    variant: "filtered",
    onClearFilters: undefined,
  },
}

export const PanelError: Story = {
  render: () => <PanelErrorState onRetry={fn()} />,
}

export const PanelErrorCustomText: Story = {
  render: () => (
    <PanelErrorState
      title="Execution chart failed"
      description="The chart could not render the last 30 days of runs."
      onRetry={fn()}
    />
  ),
}

export const PanelErrorNoRetry: Story = {
  render: () => <PanelErrorState />,
}
