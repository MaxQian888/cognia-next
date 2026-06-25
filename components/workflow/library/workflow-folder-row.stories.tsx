import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowFolderRow } from "./workflow-folder-row"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"

const folder: WorkflowFolder = {
  id: "wff_team",
  name: "Team automations",
  parentFolderId: ROOT_FOLDER_ID,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_086_400_000,
}

const meta = {
  title: "Workflow/WorkflowFolderRow",
  component: WorkflowFolderRow,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="w-[640px]">{Story()}</div>],
  args: { folder },
} satisfies Meta<typeof WorkflowFolderRow>

export default meta
type Story = StoryObj<typeof meta>

// A folder in the compact list view.
export const Default: Story = {}
