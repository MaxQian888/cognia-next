import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginDiscoverPane } from "./plugin-discover-pane"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginMarketplaceStore } from "@/stores/plugin-runtime/plugin-marketplace-store"

// Discover section — a thin scroll wrapper around the marketplace storefront.
// Built-in entries come from the seeded Dexie rows; remote registry results land
// on their empty/error branch with no registry reachable in Storybook.

const meta = {
  title: "Plugins/Discover/PluginDiscoverPane",
  component: PluginDiscoverPane,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[700px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginDiscoverPane>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  beforeEach: async () => {
    resetStore(usePluginMarketplaceStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginMarketplaceStore)
  },
}
