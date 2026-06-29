import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowRenameDialog } from "./workflow-rename-dialog"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"

// Controlled rename dialog for one workflow. Open it to see the name input
// seeded from the workflow. Pure props (open / onOpenChange / workflow);
// committing calls Dexie which resolves against the empty Storybook DB.
const meta = {
  title: "Workflow/Library/RenameDialog",
  component: WorkflowRenameDialog,
  parameters: { layout: "fullscreen" },
  args: {
    workflow: makeWorkflow({ name: "Daily standup summary" }),
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof WorkflowRenameDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

// Closed — nothing rendered (the dialog body only mounts while open).
export const Closed: Story = {
  args: { open: false },
}
