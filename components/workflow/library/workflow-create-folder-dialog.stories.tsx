import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowCreateFolderDialog } from "./workflow-create-folder-dialog"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"

// Propless, store-driven. Doubles as create + rename: `createFolderParentId`
// opens it in create mode, `renameFolderTarget` opens it in rename mode.
const meta = {
  title: "Workflow/Library/CreateFolderDialog",
  component: WorkflowCreateFolderDialog,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowCreateFolderDialog>

export default meta
type Story = StoryObj<typeof meta>

// Create a new folder under the root.
export const Create: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { createFolderParentId: ROOT_FOLDER_ID })
  },
}

// Rename an existing folder (name pre-filled).
export const Rename: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, {
      renameFolderTarget: { id: "wff_team", name: "Team automations" },
    })
  },
}
