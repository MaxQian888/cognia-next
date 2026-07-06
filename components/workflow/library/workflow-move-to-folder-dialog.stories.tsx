import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowMoveToFolderDialog } from "./workflow-move-to-folder-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Propless, store-driven. Opens when `moveDialogTarget` is set; the body lists
// the folder tree (resolved from Dexie — empty here, so just the root).
const meta = {
  title: "Workflow/Library/MoveToFolderDialog",
  component: WorkflowMoveToFolderDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowMoveToFolderDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { moveDialogTarget: { ids: ["wf_1", "wf_2"] } })
  },
}
