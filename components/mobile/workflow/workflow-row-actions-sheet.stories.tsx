import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowRowActionsSheet } from "./workflow-row-actions-sheet"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useSettingsStore } from "@/stores/settings"
import type { AppSettings } from "@/lib/claude/types"

// Long-press action sheet for a workflow row (Run / Pause / Pin / Graph /
// Delete). Reads `useSettingsStore` for the pinned set to label the Pin
// action. `workflow: null` keeps the sheet closed.
const workflow = makeWorkflow({ id: "wf-actions", name: "Release notes digest" })

const meta = {
  title: "Mobile/Workflow/WorkflowRowActionsSheet",
  component: WorkflowRowActionsSheet,
  parameters: { layout: "fullscreen" },
  args: { workflow, onOpenChange: fn() },
  beforeEach: () => {
    resetStore(useSettingsStore)
  },
} satisfies Meta<typeof WorkflowRowActionsSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Unpinned: Story = {}

export const Pinned: Story = {
  beforeEach: () => {
    useSettingsStore.setState({
      settings: { pinnedWorkflowIds: [workflow.id] } as unknown as AppSettings,
    })
  },
}
