import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkspaceTrustDialog } from "./workspace-trust-dialog"

// First-time-trust prompt for projects that ship hooks / auto-running skills.
// Stays closed when `workspacePath` is null.
const meta = {
  title: "Chat/WorkspaceTrustDialog",
  component: WorkspaceTrustDialog,
  parameters: { layout: "centered" },
  args: {
    workspacePath: "/Users/dev/projects/cognia-next",
    pendingActions: ["UserPromptSubmit hook (command)", "PreToolUse hook on Bash"],
    onResolved: fn(),
  },
} satisfies Meta<typeof WorkspaceTrustDialog>

export default meta
type Story = StoryObj<typeof meta>

/** Open with two pending side-effecting actions. */
export const WithPendingActions: Story = {}

/** Open with no listed actions — just the workspace path + trust copy. */
export const NoPendingActions: Story = {
  args: { pendingActions: [] },
}

/** Null path keeps the dialog closed. */
export const Closed: Story = {
  args: { workspacePath: null },
}
