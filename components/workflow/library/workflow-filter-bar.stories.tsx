import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowFilterBar } from "./workflow-filter-bar"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Type + status facet filter packed into one dropdown. The trigger shows a
// count badge when any non-default filter is active. State lives on the library
// store's `filters` slice.
const meta = {
  title: "Workflow/Library/FilterBar",
  component: WorkflowFilterBar,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowFilterBar>

export default meta
type Story = StoryObj<typeof meta>

// No active filters — no count badge.
export const Default: Story = {}

// Two active filters — the trigger shows a "2" badge.
export const ActiveFilters: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, {
      filters: { type: "template", hasTrigger: true, recentlyFailed: false },
    })
  },
}
