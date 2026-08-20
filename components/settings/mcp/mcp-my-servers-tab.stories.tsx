import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpMyServersTab } from "./mcp-my-servers-tab"
import { resetStore } from "@/lib/storybook/seed-stores"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeMcpCapabilityList, makeMcpServerList } from "@/lib/storybook/fixtures/settings-mcp"

// Store + Dexie: view/group/filter UI state lives on `useMcpPanelStore`; the
// server rows are read from IndexedDB via `useLiveQuery(listMcpServers)`. Empty
// DB shows the empty state; seed `mcpServers` to render the populated list.
const meta = {
  title: "Settings/MCP/McpMyServersTab",
  component: McpMyServersTab,
  beforeEach: () => {
    resetStore(useMcpPanelStore)
  },
  // The tab is a master-detail grid that fills its parent, so the decorator
  // has to supply a bounded height — an auto-height box collapses the rail.
  decorators: [
    (Story) => (
      <div className="flex h-[620px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpMyServersTab>

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  beforeEach: async () => {
    resetStore(useMcpPanelStore)
    await seedDb(async () => {})
  },
}

export const Populated: Story = {
  beforeEach: async () => {
    resetStore(useMcpPanelStore)
    await seedDb(async (db) => {
      await db.mcpServers.bulkPut(makeMcpServerList())
      // Seeding the capability cache is what makes the Tools card render
      // outside the desktop shell (discovery itself is desktop-only).
      await db.mcpCapabilityCache.bulkPut(makeMcpCapabilityList())
    })
  },
}
