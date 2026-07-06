import type { Meta, StoryObj } from "@storybook/nextjs"

import { PluginsPanel } from "./plugins-panel"
import { seedDb } from "@/lib/storybook/seed-db"
import type { PluginRow } from "@/lib/db/plugin-types"

// Lists installed plugins from the `plugins` Dexie table with a per-row enable
// Switch. Empty DB → the "no plugins" copy; the seeded story shows real rows.
const meta = {
  title: "Mobile/Discover/PluginsPanel",
  component: PluginsPanel,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginsPanel>

export default meta
type Story = StoryObj<typeof meta>

function makePlugin(over: Partial<PluginRow> = {}): PluginRow {
  return {
    id: "plugin-x",
    name: "Plugin X",
    version: "1.2.0",
    status: "enabled",
    source: "marketplace",
    type: "frontend",
    enabled: true,
    capabilities: [],
    path: "/plugins/plugin-x",
    manifest: {},
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

export const Seeded: Story = {
  beforeEach: async () => {
    await seedDb(async (db) => {
      await db.plugins.bulkPut([
        makePlugin({ id: "clipboard-history", name: "Clipboard history", version: "0.4.1", enabled: true }),
        makePlugin({ id: "screenshot", name: "Screenshot", version: "1.0.0", enabled: false }),
        makePlugin({ id: "web-tools", name: "Web tools", version: "2.3.0", enabled: true }),
      ])
    })
  },
}

export const Empty: Story = {
  beforeEach: async () => {
    await seedDb(async () => {})
  },
}
