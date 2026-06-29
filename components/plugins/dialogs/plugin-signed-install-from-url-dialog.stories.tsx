import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginSignedInstallFromUrlDialog } from "./plugin-signed-install-from-url-dialog"

// Controlled dialog for installing a signed plugin bundle from URLs (bundle +
// detached signature + public key). Walks input → preview → installing → error
// stages; preview/install are host actions, so the story covers the input stage.

const meta = {
  title: "Plugins/Dialogs/PluginSignedInstallFromUrlDialog",
  component: PluginSignedInstallFromUrlDialog,
  args: { open: true, onOpenChange: fn(), onInstalled: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginSignedInstallFromUrlDialog>

export default meta
type Story = StoryObj<typeof meta>

export const InputStage: Story = {}
