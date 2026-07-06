import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowBulkTagDialog } from "./workflow-bulk-tag-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Propless, store-driven add-tag dialog for the current selection. Opens when
// `tagDialogTarget` is set.
const meta = {
  title: "Workflow/Library/BulkTagDialog",
  component: WorkflowBulkTagDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowBulkTagDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { tagDialogTarget: { ids: ["wf_1", "wf_2", "wf_3"] } })
  },
}
