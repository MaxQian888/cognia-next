import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { DeleteConfirmDialog } from "./delete-confirm-dialog"

const meta = {
  title: "A2UI/DeleteConfirmDialog",
  component: DeleteConfirmDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onConfirm: fn(),
  },
} satisfies Meta<typeof DeleteConfirmDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
