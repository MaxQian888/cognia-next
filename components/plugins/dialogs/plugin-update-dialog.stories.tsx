import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginUpdateDialog } from "./plugin-update-dialog"

// Controlled "check for updates" dialog. On open it asks the updater client for
// available updates; the web/Storybook updater client reports none, so the
// dialog lands on its no-updates state with a manual refresh control.

const meta = {
  title: "Plugins/Dialogs/PluginUpdateDialog",
  component: PluginUpdateDialog,
  args: { open: true, onClose: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginUpdateDialog>

export default meta
type Story = StoryObj<typeof meta>

export const NoUpdates: Story = {}
