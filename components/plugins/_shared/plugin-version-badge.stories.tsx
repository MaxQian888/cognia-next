import type { Meta, StoryObj } from "@storybook/nextjs-vite"

import { PluginVersionBadge } from "./plugin-version-badge"

// Tiny `v{version}` badge shared by the marketplace card, detail Sheet header,
// library row, and discovery hero strip. Stories cover the three Badge
// variants plus a prerelease/long version string. Small surface → centered.

const meta = {
  title: "Plugins/Shared/PluginVersionBadge",
  component: PluginVersionBadge,
  args: { version: "1.4.2" },
} satisfies Meta<typeof PluginVersionBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Secondary: Story = {}

export const Outline: Story = { args: { variant: "outline" } }

export const Default: Story = { args: { variant: "default" } }

// Prerelease semver with build metadata renders verbatim (tabular-nums).
export const Prerelease: Story = { args: { version: "2.0.0-beta.3" } }

// All three variants side by side.
export const AllVariants: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <PluginVersionBadge version="1.4.2" variant="secondary" />
      <PluginVersionBadge version="1.4.2" variant="outline" />
      <PluginVersionBadge version="1.4.2" variant="default" />
    </div>
  ),
}
