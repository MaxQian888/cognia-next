import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginCategorySidebar } from "./plugin-category-sidebar"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Left-rail capability filter for the library. Badge counts come from
// `usePlugins()` (live totals + per-capability counts); the active capability is
// the plugins-store filter. Seed the DB so the counts are non-zero.

const meta = {
  title: "Plugins/PluginCategorySidebar",
  component: PluginCategorySidebar,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-64">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginCategorySidebar>

export default meta
type Story = StoryObj<typeof meta>

export const WithCounts: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async () => {})
  },
}
