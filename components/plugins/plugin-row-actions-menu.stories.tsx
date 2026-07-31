import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginRowActionsMenu } from "./plugin-row-actions-menu"
import { makePluginRow } from "@/lib/storybook/fixtures/plugins"

// Per-row "more actions" dropdown for installed plugins (open / configure /
// review permissions / optional rollback / enable-disable / uninstall). Fully
// prop-driven; the enable/disable label flips with `plugin.enabled`, and the
// Rollback item only appears when `onRollback` is supplied.

const handlers = {
  onOpen: fn(),
  onConfigure: fn(),
  onReviewPermissions: fn(),
  onToggleEnabled: fn(),
  onUninstall: fn(),
  onRollback: fn(),
}

const meta = {
  title: "Plugins/PluginRowActionsMenu",
  component: PluginRowActionsMenu,
  args: { plugin: makePluginRow(), ...handlers },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginRowActionsMenu>

export default meta
type Story = StoryObj<typeof meta>

// Enabled plugin with the rollback item available.
export const Enabled: Story = {}

// Disabled plugin → the toggle item reads "Enable".
export const Disabled: Story = {
  args: { plugin: makePluginRow({ enabled: false, status: "disabled" }) },
}

// No rollback handler → the Rollback item is hidden.
export const NoRollback: Story = {
  args: { onRollback: undefined },
}
