import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { AutoComposeDialog } from "./auto-compose-dialog"

const meta = {
  title: "Agent/Workspace/AutoCompose/Dialog",
  component: AutoComposeDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onComposed: fn(),
  },
} satisfies Meta<typeof AutoComposeDialog>

export default meta
type Story = StoryObj<typeof meta>

// Input phase: objective field + collapsible advanced options. No model call
// happens until the operator clicks Generate / Quick create.
export const Input: Story = {}

export const Closed: Story = {
  args: { open: false },
}
