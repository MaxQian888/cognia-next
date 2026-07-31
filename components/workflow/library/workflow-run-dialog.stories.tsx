import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowRunDialog } from "./workflow-run-dialog"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"

// Start a fresh run of a saved workflow from the library, optionally with a JSON
// trigger payload. Open the dialog to see the payload textarea + Run action.
const meta = {
  title: "Workflow/Library/RunDialog",
  component: WorkflowRunDialog,
  parameters: { layout: "fullscreen" },
  args: {
    workflow: makeWorkflow({ name: "Triage inbound message" }),
    open: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof WorkflowRunDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
