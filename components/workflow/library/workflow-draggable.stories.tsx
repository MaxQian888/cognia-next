import type { Meta, StoryObj } from "@storybook/nextjs"
import { DndContext } from "@dnd-kit/core"

import { WorkflowDraggable } from "./workflow-draggable"

// Drag-source wrapper for a workflow card/row. The orchestrator normally
// supplies the DndContext; the story wraps it so the draggable wiring resolves.
const meta = {
  title: "Workflow/Library/WorkflowDraggable",
  component: WorkflowDraggable,
  parameters: { layout: "centered" },
  decorators: [(Story) => <DndContext>{Story()}</DndContext>],
  args: { id: "wf_demo" },
} satisfies Meta<typeof WorkflowDraggable>

export default meta
type Story = StoryObj<typeof meta>

// Wraps an arbitrary card-like child; drag with a small activation distance.
export const Default: Story = {
  args: {
    children: (
      <div className="w-[260px] rounded-lg border bg-card p-4 shadow-sm">
        <p className="text-sm font-medium">Daily standup summary</p>
        <p className="text-xs text-muted-foreground">Drag me onto a folder</p>
      </div>
    ),
  },
}
