import type { Meta, StoryObj } from "@storybook/nextjs"
import { DndContext } from "@dnd-kit/core"

import { WorkflowFolderDroppable } from "./workflow-folder-droppable"

// Drop-target wrapper for a folder destination. Highlights (ring) while a
// workflow is dragged over it. Wrapped in a DndContext so the droppable wiring
// resolves.
const meta = {
  title: "Workflow/Library/WorkflowFolderDroppable",
  component: WorkflowFolderDroppable,
  parameters: { layout: "centered" },
  decorators: [(Story) => <DndContext>{Story()}</DndContext>],
  args: { folderId: "wff_team" },
} satisfies Meta<typeof WorkflowFolderDroppable>

export default meta
type Story = StoryObj<typeof meta>

// Idle drop target wrapping a folder tile.
export const Default: Story = {
  args: {
    children: (
      <div className="flex w-[240px] items-center gap-3 rounded-lg border bg-card p-4">
        <div className="text-2xl">📁</div>
        <div>
          <p className="text-sm font-medium">Team automations</p>
          <p className="text-xs text-muted-foreground">3 workflows</p>
        </div>
      </div>
    ),
  },
}
