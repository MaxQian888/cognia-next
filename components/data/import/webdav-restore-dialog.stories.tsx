import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { WebDavRestoreDialog } from "./webdav-restore-dialog"
import { Button } from "@/components/ui/button"

// Restores a backup from a configured WebDAV remote. Controlled `open` renders
// the dialog body (remote listing + restore flow).
const meta = {
  title: "Data/WebDavRestoreDialog",
  component: WebDavRestoreDialog,
  args: { open: true, onOpenChange: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WebDavRestoreDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const ViaTrigger: Story = {
  args: {
    open: undefined,
    onOpenChange: undefined,
    trigger: <Button variant="outline">Restore from WebDAV</Button>,
  },
}
