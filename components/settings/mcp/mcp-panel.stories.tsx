import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpPanel } from "./mcp-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { seedDb } from "@/lib/storybook/seed-db"
import { makeMcpCapabilityList, makeMcpServerList } from "@/lib/storybook/fixtures/settings-mcp"

// The full four-tab MCP panel. Active tab lives on `useMcpPanelStore`; the My
// Servers tab reads rows from Dexie. Each story seeds the tab + (where useful)
// the DB. Wrapped in a fixed-height box because the panel is `h-full`.
const meta = {
  title: "Settings/MCP/McpPanel",
  component: McpPanel,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useMcpPanelStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[680px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpPanel>

export default meta
type Story = StoryObj<typeof meta>

export const MyServers: Story = {
  beforeEach: async () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, { activeTab: "my-servers" })
    await seedDb(async (db) => {
      await db.mcpServers.bulkPut(makeMcpServerList())
      // Seeding the capability cache is what makes the Tools card render
      // outside the desktop shell (discovery itself is desktop-only).
      await db.mcpCapabilityCache.bulkPut(makeMcpCapabilityList())
    })
  },
}

export const Presets: Story = {
  beforeEach: () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, { activeTab: "presets" })
  },
}

export const Agents: Story = {
  beforeEach: () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, { activeTab: "agents" })
  },
}

export const Health: Story = {
  beforeEach: async () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, { activeTab: "health" })
    await seedDb(async () => {})
  },
}
