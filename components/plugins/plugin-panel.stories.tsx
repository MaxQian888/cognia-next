import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginPanel } from "./plugin-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// The full /plugins shell — nav rail, section panes (library / discover /
// governance / devtools), and the detail pane, wired through the plugins store.
// Seed the DB so the library lands populated.

const meta = {
  title: "Plugins/PluginPanel",
  component: PluginPanel,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[720px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginPanel>

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
