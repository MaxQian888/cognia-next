import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowFolderCard } from "./workflow-folder-card"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"

const folder: WorkflowFolder = {
  id: "wff_team",
  name: "Team automations",
  parentFolderId: ROOT_FOLDER_ID,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_086_400_000,
}

const meta = {
  title: "Workflow/WorkflowFolderCard",
  component: WorkflowFolderCard,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[340px]">{Story()}</div>],
  args: { folder },
} satisfies Meta<typeof WorkflowFolderCard>

export default meta
type Story = StoryObj<typeof meta>

// A folder tile in the grid view.
export const Default: Story = {}
