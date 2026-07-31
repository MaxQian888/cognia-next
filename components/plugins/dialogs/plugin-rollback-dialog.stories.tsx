import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginRollbackDialog } from "./plugin-rollback-dialog"

// Controlled rollback dialog. Loads available backup versions for the target
// plugin from the host client; outside Tauri (this Storybook) there is no
// backend, so it shows the "not available off-desktop" note.

const meta = {
  title: "Plugins/Dialogs/PluginRollbackDialog",
  component: PluginRollbackDialog,
  args: { open: true, pluginId: "com.acme.web-tools", onClose: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginRollbackDialog>

export default meta
type Story = StoryObj<typeof meta>

// Open on the web branch — no host backups available.
export const WebFallback: Story = {}
