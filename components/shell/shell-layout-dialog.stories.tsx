import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ShellLayoutDialog } from "./shell-layout-dialog"

// Thin dialog shell around <ShellLayoutCustomizer/>, opened from the nav rail,
// the title bar's context / Views menu, or the status bar's context menu.
// Rendered open so the modal content is visible.
const meta = {
  title: "Shell/ShellLayoutDialog",
  component: ShellLayoutDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof ShellLayoutDialog>

export default meta
type Story = StoryObj<typeof meta>

export const FromTheRail: Story = { args: { surface: "sidebar" } }
export const FromTheTopBar: Story = { args: { surface: "title" } }
export const FromTheBottomBar: Story = { args: { surface: "status" } }
