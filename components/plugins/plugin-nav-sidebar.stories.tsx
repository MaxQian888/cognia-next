import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginNavSidebar } from "./plugin-nav-sidebar"
import { seedDb } from "@/lib/storybook/seed-db"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { samplePluginRows } from "@/lib/storybook/fixtures/plugins"
import { usePluginsStore } from "@/stores/plugins"

// Left navigation rail for /plugins — top-level sections (Library / Discover /
// Governance / Devtools) plus expandable sub-items, with the active section
// driven by the plugins store.

const meta = {
  title: "Plugins/PluginNavSidebar",
  component: PluginNavSidebar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-[600px] w-64 border-r">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginNavSidebar>

export default meta
type Story = StoryObj<typeof meta>

export const LibraryActive: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    seedStore(usePluginsStore, { activeSection: "library" as never })
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}

export const GovernanceActive: Story = {
  beforeEach: async () => {
    resetStore(usePluginsStore)
    seedStore(usePluginsStore, { activeSection: "governance" as never })
    await seedDb(async (db) => {
      await db.plugins.bulkPut(samplePluginRows())
    })
    return () => resetStore(usePluginsStore)
  },
}
