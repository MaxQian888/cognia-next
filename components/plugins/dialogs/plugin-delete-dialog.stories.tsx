import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginDeleteDialog } from "./plugin-delete-dialog"

// Confirmation AlertDialog for uninstalling a plugin. Controlled via `open`;
// the destructive confirm is gated behind this dialog so an uninstall never
// fires by accident.

const meta = {
  title: "Plugins/Dialogs/PluginDeleteDialog",
  component: PluginDeleteDialog,
  args: {
    open: true,
    pluginName: "Web Tools",
    onCancel: fn(),
    onConfirm: fn(),
  },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginDeleteDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

// A long plugin name to confirm the title still wraps cleanly.
export const LongName: Story = {
  args: { pluginName: "Enterprise Knowledge Graph & Retrieval Augmentation Suite" },
}
