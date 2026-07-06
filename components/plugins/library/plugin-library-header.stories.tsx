import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { PluginLibraryHeader } from "./plugin-library-header"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Library header — search box, sort control, filter-sheet trigger, and the
// "check updates" / "sync registry" actions. Totals come from `usePlugins()`;
// the actions are wired through props.

const meta = {
  title: "Plugins/Library/PluginLibraryHeader",
  component: PluginLibraryHeader,
  args: { onCheckUpdates: fn(), onSyncRegistry: fn(), syncing: false },
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginLibraryHeader>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

// Registry sync in progress → the sync control shows its spinner.
export const Syncing: Story = {
  args: { syncing: true },
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}
