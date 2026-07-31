import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginDiscovery } from "./plugin-discovery"

// Featured-plugin discovery grid. Pulls featured entries from the marketplace
// hook and routes every install through the `onInstall` prop (so the caller can
// run the pre-install chain). With no registry reachable in Storybook the
// featured set is empty, so this lands on its empty state.

const meta = {
  title: "Plugins/PluginDiscovery",
  component: PluginDiscovery,
  args: { onInstall: fn() },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginDiscovery>

export default meta
type Story = StoryObj<typeof meta>

// No featured entries available → empty state.
export const Empty: Story = {}
