import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

import { PluginDiscovery } from "./plugin-discovery"

// Featured-plugin discovery grid. Reads the featured entries from the
// marketplace panel's query state and routes every install through the
// `onInstall` prop (so the caller can run the pre-install chain).

const FEATURED: PluginMarketplaceEntry[] = [
  {
    id: "cognia-web-tools",
    name: "Web Tools",
    version: "1.2.0",
    type: "plugin",
    description: "Fetch, read and summarise web pages from chat.",
  },
  {
    id: "cognia-pdf",
    name: "PDF",
    version: "0.4.1",
    type: "plugin",
    description: "Read, split and annotate PDF documents.",
  },
]

const meta = {
  title: "Plugins/PluginDiscovery",
  component: PluginDiscovery,
  args: {
    onInstall: fn(),
    market: { state: { kind: "ready", results: FEATURED }, featured: FEATURED, installingId: null },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginDiscovery>

export default meta
type Story = StoryObj<typeof meta>

export const Featured: Story = {}

// One entry mid-install: its button shows the spinner.
export const Installing: Story = {
  args: {
    market: {
      state: { kind: "ready", results: FEATURED },
      featured: FEATURED,
      installingId: "cognia-pdf",
    },
  },
}

// Nothing featured: the strip renders nothing and leaves the empty state to
// the marketplace below it.
export const NothingFeatured: Story = {
  args: { market: { state: { kind: "ready", results: [] }, featured: [], installingId: null } },
}
