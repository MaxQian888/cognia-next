import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginMarketplaceSheet } from "./plugin-marketplace-sheet"

// Bottom sheet surfacing the plugin marketplace via `usePluginMarketplace`.
// Closed by default (the trigger button is what renders); opening it fetches
// the catalog. On mobile the install action is disabled.
const meta = {
  title: "Discover/PluginMarketplaceSheet",
  component: PluginMarketplaceSheet,
  args: { installedIds: new Set<string>() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginMarketplaceSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithInstalled: Story = {
  args: { installedIds: new Set(["github-delivery", "web-tools"]) },
}
