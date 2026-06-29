import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginMarketplaceSourcesDialog } from "./plugin-marketplace-sources-dialog"
import { seedDb } from "@/lib/storybook/seed-db"

// Controlled dialog for managing GitHub "marketplace repo" sources. Lists the
// configured sources (a Dexie live query) and lets the user add/remove repo
// references. Seed `pluginMarketplaceSources` to show a populated list.

const meta = {
  title: "Plugins/Marketplace/PluginMarketplaceSourcesDialog",
  component: PluginMarketplaceSourcesDialog,
  args: { open: true, onOpenChange: fn() },
  parameters: { layout: "centered" },
} satisfies Meta<typeof PluginMarketplaceSourcesDialog>

export default meta
type Story = StoryObj<typeof meta>

// No configured sources → the empty list + add form.
export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}

// A couple of configured GitHub sources.
export const WithSources: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.pluginMarketplaceSources.bulkPut([
        { id: "acme/plugins", repoRef: "acme/plugins", name: "Acme Plugins", addedAt: Date.now() },
        {
          id: "cognia/community",
          repoRef: "github.com/cognia/community",
          name: "Cognia Community",
          addedAt: Date.now() - 86_400_000,
        },
      ])
    })
  },
}
