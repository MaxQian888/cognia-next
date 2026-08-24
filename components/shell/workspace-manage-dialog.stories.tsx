import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WorkspaceManageDialog } from "./workspace-manage-dialog"

// Create / edit / delete workspaces (master-detail). Reads the project store;
// with no projects the list is empty and the editor shows its "select a
// workspace" hint. Rendered open so the dialog content is visible.
const meta = {
  title: "Shell/WorkspaceManageDialog",
  component: WorkspaceManageDialog,
  parameters: { layout: "fullscreen" },
  args: { open: true, onOpenChange: fn() },
} satisfies Meta<typeof WorkspaceManageDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const AutoCreate: Story = {}
