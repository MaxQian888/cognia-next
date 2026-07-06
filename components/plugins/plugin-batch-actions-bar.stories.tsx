import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginBatchActionsBar } from "./plugin-batch-actions-bar"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Bulk-action bar shown when one or more library rows are selected. Reflects the
// selection (from the plugins store) against the live rows (Dexie) to drive the
// enable-all / disable-all / update / delete actions. Renders nothing when the
// selection is empty.

const meta = {
  title: "Plugins/PluginBatchActionsBar",
  component: PluginBatchActionsBar,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PluginBatchActionsBar>

export default meta
type Story = StoryObj<typeof meta>

// Two selected plugins → the bar shows enable/disable + delete controls.
export const Selection: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    seedStore(usePluginsStore, {
      selection: new Set(["com.acme.web-tools", "com.acme.screenshot"]),
    })
    return () => resetStore(usePluginsStore)
  },
}
