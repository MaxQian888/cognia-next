import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowSortMenu } from "./workflow-sort-menu"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Sort dropdown — a radio group over the five sort modes, persisted to the
// library store's `sort` field. Open the trigger to see the selected mode.
const meta = {
  title: "Workflow/Library/SortMenu",
  component: WorkflowSortMenu,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowSortMenu>

export default meta
type Story = StoryObj<typeof meta>

// Default sort — "updated".
export const Default: Story = {}

// Sorted by run count.
export const ByRunCount: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { sort: "runCount" })
  },
}
