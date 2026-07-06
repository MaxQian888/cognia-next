import type { Meta, StoryObj } from "@storybook/nextjs"
import { DndContext } from "@dnd-kit/core"

import { WorkflowLibraryList } from "./workflow-library-list"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import type { RunStatus } from "@/types/workflow/visual"

const folders: WorkflowFolder[] = [
  {
    id: "wff_team",
    name: "Team automations",
    parentFolderId: ROOT_FOLDER_ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_086_400_000,
  },
]

const workflows = Array.from({ length: 12 }, (_, i) =>
  makeWorkflow({ id: `wf_${i}`, name: `Workflow ${i + 1}` })
)

const runCounts = new Map<string, number>([
  ["wf_0", 21],
  ["wf_1", 3],
])
const lastStatuses = new Map<string, RunStatus>([
  ["wf_0", "succeeded"],
  ["wf_1", "running"],
])

// Virtualized list view — folders then workflows in one window. Needs a sized
// scroll host and a DndContext for the draggable rows.
const meta = {
  title: "Workflow/Library/LibraryList",
  component: WorkflowLibraryList,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
  decorators: [
    (Story) => (
      <DndContext>
        <div className="h-[640px] w-full">{Story()}</div>
      </DndContext>
    ),
  ],
} satisfies Meta<typeof WorkflowLibraryList>

export default meta
type Story = StoryObj<typeof meta>

// A folder row followed by a dozen workflow rows.
export const Populated: Story = {
  args: { folders, workflows, runCounts, lastStatuses },
}
