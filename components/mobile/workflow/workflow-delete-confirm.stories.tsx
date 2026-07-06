import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkflowDeleteConfirm } from "./workflow-delete-confirm"
import { makeWorkflow } from "@/lib/storybook/fixtures/mobile-workflow"

// Destructive-action confirm dialog for workflow deletion. Pure w.r.t. render
// (the Dexie delete + outbound mirror only fire on confirm). Open by default
// so the dialog body is visible.
const meta = {
  title: "Mobile/Workflow/WorkflowDeleteConfirm",
  component: WorkflowDeleteConfirm,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    workflow: makeWorkflow({ name: "Daily standup digest" }),
  },
} satisfies Meta<typeof WorkflowDeleteConfirm>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
