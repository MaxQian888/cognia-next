import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { fn } from "storybook/test"

import { InstallButton } from "./install-button"

// Single source of truth for the Install / Uninstall button across the
// marketplace card, detail Sheet, discover rows, and discovery hero strip.
// Stories cover the available / installing / installed / uninstalling states,
// the explicit mobile-gating disabled prop, and a custom install label.

const callbacks = { onInstall: fn(), onUninstall: fn() }

const meta = {
  title: "Plugins/Shared/InstallButton",
  component: InstallButton,
  args: { installed: false, installing: false, ...callbacks },
} satisfies Meta<typeof InstallButton>

export default meta
type Story = StoryObj<typeof meta>

// Not installed, idle → "Install".
export const Available: Story = {}

// Install in flight → spinner + "Installing…", disabled.
export const Installing: Story = { args: { installing: true } }

// Installed with an uninstall handler → ghost "Uninstall".
export const Installed: Story = { args: { installed: true } }

// Installed and an uninstall in flight → "Uninstalling…", disabled.
export const Uninstalling: Story = { args: { installed: true, installing: true } }

// Forced disabled regardless of state (e.g. mobile gating).
export const Disabled: Story = { args: { disabled: true } }

// Call-site-supplied label overriding the shared default.
export const CustomLabel: Story = { args: { installLabel: "Add to workspace" } }

// Full state matrix at a glance.
export const AllStates: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <InstallButton installed={false} installing={false} {...callbacks} />
      <InstallButton installed={false} installing {...callbacks} />
      <InstallButton installed installing={false} {...callbacks} />
      <InstallButton installed installing {...callbacks} />
      <InstallButton installed={false} installing={false} disabled {...callbacks} />
    </div>
  ),
}
