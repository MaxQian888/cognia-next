import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { SidebarCustomizeDialog } from "./sidebar-customize-dialog"

// Thin dialog shell around <SidebarCustomizer/>. Rendered open so the modal
// content (the three-bucket editor) is visible.
const meta = {
  title: "Shell/SidebarCustomizeDialog",
  component: SidebarCustomizeDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof SidebarCustomizeDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
