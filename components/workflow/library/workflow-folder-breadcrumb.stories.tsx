import type { Meta, StoryObj } from "@storybook/nextjs"
import { DndContext } from "@dnd-kit/core"

import { WorkflowFolderBreadcrumb } from "./workflow-folder-breadcrumb"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"

const mk = (id: string, name: string, parentFolderId: string): WorkflowFolder => ({
  id,
  name,
  parentFolderId,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_086_400_000,
})

const meta = {
  title: "Workflow/WorkflowFolderBreadcrumb",
  component: WorkflowFolderBreadcrumb,
  parameters: { layout: "padded" },
  // Each crumb is a drop target (WorkflowFolderDroppable) — the real library
  // supplies the DndContext, so mirror it here.
  decorators: [(Story) => <DndContext>{Story()}</DndContext>],
} satisfies Meta<typeof WorkflowFolderBreadcrumb>

export default meta
type Story = StoryObj<typeof meta>

// Root only — just the "All workflows" crumb.
export const Root: Story = {
  args: { path: [] },
}

// A nested path two levels deep.
export const Nested: Story = {
  args: {
    path: [
      mk("wff_projects", "Projects", ROOT_FOLDER_ID),
      mk("wff_team_a", "Team A", "wff_projects"),
    ],
  },
}
