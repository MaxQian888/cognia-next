import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowDeleteDialog } from "./workflow-delete-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Propless, store-driven delete confirmation. Opens when the library store's
// `deleteDialogTarget` is non-null; the title reflects the id count.
const meta = {
  title: "Workflow/Library/DeleteDialog",
  component: WorkflowDeleteDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowDeleteDialog>

export default meta
type Story = StoryObj<typeof meta>

// Single-workflow delete.
export const SingleTarget: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { deleteDialogTarget: { ids: ["wf_1"] } })
  },
}

// Bulk delete of three workflows.
export const BulkTarget: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { deleteDialogTarget: { ids: ["wf_1", "wf_2", "wf_3"] } })
  },
}
