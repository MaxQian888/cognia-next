import type { Meta, StoryObj } from "@storybook/nextjs"

import { WorkflowLibraryViewToggle } from "./workflow-library-view-toggle"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"

// Grid/list layout toggle bound to the persisted `viewMode` field on the
// library store. Reset the store between stories so the selected mode is
// deterministic.
const meta = {
  title: "Workflow/Library/ViewToggle",
  component: WorkflowLibraryViewToggle,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
  },
} satisfies Meta<typeof WorkflowLibraryViewToggle>

export default meta
type Story = StoryObj<typeof meta>

// Default: grid selected.
export const Grid: Story = {}

// List view active.
export const List: Story = {
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    seedStore(useWorkflowLibraryStore, { viewMode: "list" })
  },
}
