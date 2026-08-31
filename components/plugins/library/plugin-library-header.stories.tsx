import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginLibraryHeader } from "./plugin-library-header"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Library's contribution to the page header's second tier: search, the status
// segments, the filter-sheet trigger, sort, and the list/card toggle. Totals
// come from `usePlugins()` and everything writes to the plugins store, so the
// stories seed the DB rather than passing props.
//
// The old args here (`onCheckUpdates` / `onSyncRegistry` / `syncing`) belong to
// `PluginPanelToolbar`, which lives in the header's separate action tier. This
// component has never accepted them.

const meta = {
  title: "Plugins/Library/PluginLibraryHeader",
  component: PluginLibraryHeader,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginLibraryHeader>

export default meta
type Story = StoryObj<typeof meta>

const seeded = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

export const Default: Story = { ...seeded }

// The phone shape: search takes its own line and the segments plus tools
// scroll on a second one, because a mobile body has no header controls slot
// scrolling on its behalf.
export const Stacked: Story = {
  ...seeded,
  args: { layout: "stacked" },
  parameters: { layout: "padded", viewport: { defaultViewport: "mobile1" } },
}
