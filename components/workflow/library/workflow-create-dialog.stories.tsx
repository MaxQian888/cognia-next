import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowCreateDialog } from "./workflow-create-dialog"

// New-workflow dialog (name + description). Lands the workflow in
// `parentFolderId` or the library root. Open it to see the form.
const meta = {
  title: "Workflow/Library/CreateDialog",
  component: WorkflowCreateDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof WorkflowCreateDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

// Targeting a specific folder.
export const IntoFolder: Story = {
  args: { parentFolderId: "wff_team" },
}
