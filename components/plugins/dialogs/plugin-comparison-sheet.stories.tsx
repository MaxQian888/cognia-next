import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginComparisonSheet } from "./plugin-comparison-sheet"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { usePluginMarketplaceStore } from "@/stores/plugin-runtime/plugin-marketplace-store"
import type { PluginMarketplaceEntry } from "@/hooks/plugins/use-plugin-marketplace"

// Side-by-side comparison sheet for up to two queued marketplace entries. The
// open state + queued ids come from the marketplace store; the entry data is
// passed in via the `entries` prop. The sheet auto-closes when the queue empties.

type ResolvedEntry = PluginMarketplaceEntry & {
  capabilities?: string[]
  permissions?: string[]
  signed?: boolean
}

const ENTRIES: ResolvedEntry[] = [
  {
    id: "com.acme.web-tools",
    name: "Web Tools",
    version: "2.1.0",
    description: "Fetch and parse pages from chat.",
    author: "Acme Labs",
    rating: 4.7,
    downloads: 18234,
    signed: true,
    type: "plugin",
    source: "marketplace",
    capabilities: ["tools", "mcp", "commands"],
    permissions: ["network:fetch"],
  },
  {
    id: "com.acme.shell-runner",
    name: "Shell Runner",
    version: "1.0.0",
    description: "Run shell commands from chat.",
    author: "Acme Labs",
    rating: 3.9,
    downloads: 2310,
    signed: false,
    type: "plugin",
    source: "marketplace",
    capabilities: ["tools"],
    permissions: ["shell:execute", "process:spawn"],
  },
]

const meta = {
  title: "Plugins/Dialogs/PluginComparisonSheet",
  component: PluginComparisonSheet,
  args: { entries: ENTRIES, installedIds: new Set(["com.acme.web-tools"]), onInstall: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginComparisonSheet>

export default meta
type Story = StoryObj<typeof meta>

// Two queued entries — one installed, one unsigned with dangerous permissions.
export const TwoEntries: Story = {
  beforeEach: () => {
    seedStore(usePluginMarketplaceStore, {
      comparisonOpen: true,
      comparisonIds: ["com.acme.web-tools", "com.acme.shell-runner"],
    })
    return () => resetStore(usePluginMarketplaceStore)
  },
}
