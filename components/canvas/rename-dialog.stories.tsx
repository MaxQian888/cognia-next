import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { RenameDialog } from "./rename-dialog"

// RenameDialog is a pure, controlled dialog: `open` is driven by props, so the
// stories render the open dialog directly. Enter or "Save" confirms a non-empty
// title; "Cancel" / overlay click closes it.
const meta = {
  title: "Canvas/RenameDialog",
  component: RenameDialog,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: fn(),
    onRename: fn(),
  },
} satisfies Meta<typeof RenameDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open dialog seeded with the current document title.
export const Open: Story = {
  args: {
    currentTitle: "Untitled document",
  },
}

// A longer existing title to show the input pre-filled.
export const ExistingTitle: Story = {
  args: {
    currentTitle: "Q3 architecture notes",
  },
}

// Closed dialog renders nothing — included for completeness of the open/closed states.
export const Closed: Story = {
  args: {
    open: false,
    currentTitle: "Untitled document",
  },
}
