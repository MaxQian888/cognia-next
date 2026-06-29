import type { Meta, StoryObj } from "@storybook/nextjs"

import { A2UIDialog } from "./a2ui-dialog"
import type { A2UIDialogComponent } from "@/types/a2ui/schema"
import { makeA2UIProps } from "@/lib/storybook/fixtures/a2ui"
import { childStub, withA2UISurface } from "@/lib/storybook/fixtures/a2ui-surface"

const dialog = (over: Partial<A2UIDialogComponent> = {}): A2UIDialogComponent => ({
  id: "dialog",
  component: "Dialog",
  open: true,
  title: "Delete workspace",
  description: "This action is permanent and cannot be undone.",
  children: ["dialog-body"],
  ...over,
})

const meta = {
  title: "A2UI/Layout/Dialog",
  component: A2UIDialog,
  decorators: [
    withA2UISurface({
      children: [
        childStub("dialog-body", "All projects, runs, and connectors will be removed."),
        childStub("action-cancel", "Cancel"),
        childStub("action-confirm", "Delete"),
      ],
    }),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof A2UIDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = { args: makeA2UIProps(dialog()) }

export const WithActions: Story = {
  args: makeA2UIProps(dialog({ actions: ["action-cancel", "action-confirm"], closable: true })),
}

export const TitleOnly: Story = {
  args: makeA2UIProps(dialog({ description: undefined })),
}
