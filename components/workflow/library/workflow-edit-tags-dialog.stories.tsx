import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowEditTagsDialog } from "./workflow-edit-tags-dialog"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"

// Edit-tags dialog for one workflow. Open it to see the tag editor seeded from
// the workflow's existing tags.
const meta = {
  title: "Workflow/Library/EditTagsDialog",
  component: WorkflowEditTagsDialog,
  parameters: { layout: "fullscreen" },
  args: {
    workflow: makeWorkflow({ name: "Daily standup summary", tags: ["daily", "ai", "ops"] }),
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof WorkflowEditTagsDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

// A workflow with no tags yet.
export const NoTags: Story = {
  args: { workflow: makeWorkflow({ name: "Untagged workflow", tags: [] }) },
}
