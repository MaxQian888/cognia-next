import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { InstalledMarker } from "./installed-marker"

// "Installed" badge with an optional desktop-only tooltip variant. The
// desktopOnly path is reused on Capacitor (mobile) to explain why the install
// action is disabled. Small surface → centered layout. The TooltipProvider is
// already mounted by the global preview decorator.

const meta = {
  title: "Plugins/Shared/InstalledMarker",
  component: InstalledMarker,
  args: {},
} satisfies Meta<typeof InstalledMarker>

export default meta
type Story = StoryObj<typeof meta>

// Success state — the green-check "Installed" badge.
export const Installed: Story = {}

// Mobile gating explanation; hover the badge to reveal the tooltip.
export const DesktopOnly: Story = { args: { desktopOnly: true } }

// Both variants side by side.
export const Both: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <InstalledMarker />
      <InstalledMarker desktopOnly />
    </div>
  ),
}
