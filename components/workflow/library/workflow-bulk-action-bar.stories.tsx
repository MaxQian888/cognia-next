import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowBulkActionBar } from "./workflow-bulk-action-bar"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Sticky batch-action bar shown while one or more workflows are selected. It
// returns null when the selection is empty, so stories seed the store's
// `selection` set.
const meta = {
  title: "Workflow/Library/BulkActionBar",
  component: WorkflowBulkActionBar,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowBulkActionBar>

export default meta
type Story = StoryObj<typeof meta>

// Three workflows selected — export / move / tag / delete / clear actions.
export const ThreeSelected: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, {
      selection: new Set(["wf_1", "wf_2", "wf_3"]),
      selectionMode: true,
    })
  },
}

// A single selection.
export const OneSelected: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { selection: new Set(["wf_1"]), selectionMode: true })
  },
}
