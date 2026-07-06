import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowFolderMenu } from "./workflow-folder-menu"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"

const folder: WorkflowFolder = {
  id: "wff_team",
  name: "Team automations",
  parentFolderId: ROOT_FOLDER_ID,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_086_400_000,
}

// The ⋯ rename/delete menu for a folder tile/row. Rename routes through the
// library store; delete opens an inline confirm dialog. Open the trigger to see
// the menu items.
const meta = {
  title: "Workflow/Library/FolderMenu",
  component: WorkflowFolderMenu,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
  args: { folder },
} satisfies Meta<typeof WorkflowFolderMenu>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
