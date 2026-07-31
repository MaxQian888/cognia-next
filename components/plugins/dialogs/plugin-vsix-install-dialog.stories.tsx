import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginVsixInstallDialog } from "./plugin-vsix-install-dialog"

// Controlled dialog for installing a VSIX-packaged extension. File selection +
// extraction are host actions that no-op in this browser Storybook, so the
// story covers the initial picker chrome.

const meta = {
  title: "Plugins/Dialogs/PluginVsixInstallDialog",
  component: PluginVsixInstallDialog,
  args: { open: true, onOpenChange: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginVsixInstallDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}
