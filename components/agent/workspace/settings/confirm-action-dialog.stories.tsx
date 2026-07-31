import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ConfirmActionDialog } from "./confirm-action-dialog"

const meta = {
  title: "Agent/Workspace/Settings/ConfirmActionDialog",
  component: ConfirmActionDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
    title: "Delete team?",
    description: "This permanently removes the team and its run history.",
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
  },
} satisfies Meta<typeof ConfirmActionDialog>

export default meta
type Story = StoryObj<typeof meta>

// Destructive tone (default).
export const Destructive: Story = {}

export const Warning: Story = {
  args: {
    tone: "warning",
    title: "Enable bypass permissions?",
    description: "Teammates will skip the per-tool approval prompt for this run.",
    confirmLabel: "Enable",
  },
}

// Type-to-confirm guard keeps the confirm button disabled until matched.
export const TypeToConfirm: Story = {
  args: {
    typeToConfirm: "DELETE",
    typeToConfirmLabel: "Type DELETE to confirm",
  },
}

export const Closed: Story = {
  args: { open: false },
}
