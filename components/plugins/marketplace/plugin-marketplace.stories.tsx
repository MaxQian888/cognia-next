import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginMarketplace } from "./plugin-marketplace"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginMarketplaceStore } from "@/stores/plugin-runtime/plugin-marketplace-store"

// The full marketplace storefront — search, featured/popular/recent sections,
// built-in entries, GitHub sources, and the comparison queue. Remote registry
// results are fetched via `usePluginMarketplace`; with no registry reachable in
// this Storybook the remote query lands on its empty/error branch, while the
// built-in section is populated from the seeded Dexie rows.

const meta = {
  title: "Plugins/Marketplace/PluginMarketplace",
  component: PluginMarketplace,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[700px] overflow-y-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginMarketplace>

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
