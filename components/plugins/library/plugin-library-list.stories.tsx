import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginLibraryList } from "./plugin-library-list"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// The installed-plugins list/grid. Rows come from `usePlugins()` (filtered +
// totals); selection, view mode, and the detail/configure/permission actions
// all live on the plugins store. Seed the DB to populate rows.

const meta = {
  title: "Plugins/Library/PluginLibraryList",
  component: PluginLibraryList,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginLibraryList>

export default meta
type Story = StoryObj<typeof meta>

export const CardView: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    seedStore(usePluginsStore, { listViewMode: "card" })
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

export const ListView: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    seedStore(usePluginsStore, { listViewMode: "list" })
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

// No installed plugins → the library empty state.
export const Empty: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async () => {})
  },
}
