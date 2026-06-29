import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginInstallFromUrlDialog } from "./plugin-install-from-url-dialog"

// Controlled dialog for installing a plugin from a raw URL (tarball / zip).
// Surfaces a security warning about installing arbitrary remote code; the
// actual fetch + install is a host action that no-ops in this Storybook.

const meta = {
  title: "Plugins/Dialogs/PluginInstallFromUrlDialog",
  component: PluginInstallFromUrlDialog,
  args: { open: true, onOpenChange: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginInstallFromUrlDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
