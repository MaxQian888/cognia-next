import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowListToolbar } from "./workflow-list-toolbar"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { useSettingsStore } from "@/stores/settings"

// Search / sort / filter / density / new-folder / new-workflow controls for
// the mobile workflow library. Reads the same `useWorkflowLibraryStore` slice
// the desktop library uses, plus `useSettingsStore` for the density toggle.
const meta = {
  title: "Mobile/Workflow/WorkflowListToolbar",
  component: WorkflowListToolbar,
  parameters: { layout: "fullscreen" },
  args: { onNewWorkflow: fn() },
  beforeEach: () => {
    resetStore(useWorkflowLibraryStore)
    resetStore(useSettingsStore)
  },
  decorators: [
    (Story) => (
      <div className="mx-auto w-[390px] py-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowListToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithQuery: Story = {
  beforeEach: () => {
    useWorkflowLibraryStore.setState({ query: "digest" })
  },
}
