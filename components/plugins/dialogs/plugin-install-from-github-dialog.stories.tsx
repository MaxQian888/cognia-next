import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginInstallFromGithubDialog } from "./plugin-install-from-github-dialog"

// Controlled dialog for installing a plugin from a GitHub repo reference. The
// fetch/preview steps are host actions that no-op in this browser Storybook, so
// the stories cover the initial entry form.

const meta = {
  title: "Plugins/Dialogs/PluginInstallFromGithubDialog",
  component: PluginInstallFromGithubDialog,
  args: { open: true, onOpenChange: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginInstallFromGithubDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {}

// Pre-filled with a repo reference.
export const WithInitialRef: Story = {
  args: { initialRef: "acme/web-tools" },
}
