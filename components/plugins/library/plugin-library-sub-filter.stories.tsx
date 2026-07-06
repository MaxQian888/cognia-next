import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginLibrarySubFilter } from "./plugin-library-sub-filter"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Sub-filter chip row for the library (all / enabled / disabled / errored /
// updates). Badge counts come from `usePlugins()`; the active chip is the
// `librarySubFilter` store value. Seed the DB so the counts are non-zero.

const meta = {
  title: "Plugins/Library/PluginLibrarySubFilter",
  component: PluginLibrarySubFilter,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginLibrarySubFilter>

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

// Empty library → all chips read 0.
export const Empty: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async () => {})
  },
}
