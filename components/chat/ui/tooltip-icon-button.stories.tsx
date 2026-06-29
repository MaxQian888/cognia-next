import type { Meta, StoryObj } from "@storybook/nextjs"
import { CopyIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"
import { fn } from "storybook/test"

import { TooltipIconButton } from "./tooltip-icon-button"

// Canonical icon-button-with-tooltip wrapper used across the chat block
// renderers. Hover the button to reveal the tooltip.
const meta = {
  title: "Chat/UI/TooltipIconButton",
  component: TooltipIconButton,
  parameters: { layout: "centered" },
  args: {
    "aria-label": "Copy",
    tooltip: "Copy to clipboard",
    children: <CopyIcon className="size-3.5" />,
    onClick: fn(),
  },
} satisfies Meta<typeof TooltipIconButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Outline: Story = {
  args: {
    variant: "outline",
    tooltip: "Regenerate response",
    "aria-label": "Regenerate",
    children: <RefreshCwIcon className="size-3.5" />,
  },
}

export const Destructive: Story = {
  args: {
    variant: "ghost",
    tooltip: "Delete message",
    "aria-label": "Delete",
    className: "text-destructive hover:text-destructive",
    children: <Trash2Icon className="size-3.5" />,
  },
}

export const Disabled: Story = {
  args: { disabled: true },
}
