import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginLibraryPane } from "./plugin-library-pane"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Composed library pane — sub-filter chips, active filters, and the
// list/grid stacked together. All data is read from `usePlugins()` and the
// plugins store, so the story seeds the DB.

const meta = {
  title: "Plugins/Library/PluginLibraryPane",
  component: PluginLibraryPane,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PluginLibraryPane>

export default meta
type Story = StoryObj<typeof meta>

export const Populated: Story = {
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
