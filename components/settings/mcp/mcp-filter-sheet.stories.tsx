import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpFilterSheet } from "./mcp-filter-sheet"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"

// Store-reading: the sheet's open state + the transport/status filters all live
// on `useMcpPanelStore`. Seed `filterSheetOpen: true` so the Sheet renders.
const meta = {
  title: "Settings/MCP/McpFilterSheet",
  component: McpFilterSheet,
  parameters: { layout: "fullscreen" },
  beforeEach: () => {
    resetStore(useMcpPanelStore)
  },
} satisfies Meta<typeof McpFilterSheet>

export default meta
type Story = StoryObj<typeof meta>

export const Open: Story = {
  beforeEach: () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, { filterSheetOpen: true })
  },
}

export const OpenWithActiveFilters: Story = {
  beforeEach: () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, {
      filterSheetOpen: true,
      transportFilter: "http",
      statusFilter: "enabled",
    })
  },
}
