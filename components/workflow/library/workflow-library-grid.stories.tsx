import type { Meta, StoryObj } from "@storybook/nextjs"
import { DndContext } from "@dnd-kit/core"

import { WorkflowLibraryGrid } from "./workflow-library-grid"
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
  {
    id: "wff_personal",
    name: "Personal",
    parentFolderId: ROOT_FOLDER_ID,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_086_400_000,
  },
]

const workflows = [
  makeWorkflow({ id: "wf_1", name: "Daily standup summary", tags: ["daily", "ai"] }),
  makeWorkflow({ id: "wf_2", name: "Triage inbound message" }),
  makeWorkflow({ id: "wf_3", name: "Nightly backup", tags: ["ops"] }),
]

const runCounts = new Map<string, number>([
  ["wf_1", 42],
  ["wf_2", 7],
])
const lastStatuses = new Map<string, RunStatus>([
  ["wf_1", "succeeded"],
  ["wf_2", "failed"],
])

// Grid view: a folder section above a workflow-card grid. Cards/folders are
// wrapped in dnd-kit draggable/droppable, so the story supplies a DndContext.
const meta = {
  title: "Workflow/Library/LibraryGrid",
  component: WorkflowLibraryGrid,
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
} satisfies Meta<typeof WorkflowLibraryGrid>

export default meta
type Story = StoryObj<typeof meta>

// Folders + workflows with run badges.
export const Populated: Story = {
  args: { folders, workflows, runCounts, lastStatuses },
}

// Workflows only — no folder section.
export const WorkflowsOnly: Story = {
  args: { folders: [], workflows },
}
