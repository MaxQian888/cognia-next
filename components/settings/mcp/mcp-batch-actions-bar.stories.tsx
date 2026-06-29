import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpBatchActionsBar } from "./mcp-batch-actions-bar"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { makeMcpServerList } from "@/lib/storybook/fixtures/settings-mcp"

const servers = makeMcpServerList()

// The floating bar reads its selection from `useMcpPanelStore` and renders
// nothing when the selection is empty (AnimatePresence). Seed a selection so the
// bar is visible. `parameters.layout: "fullscreen"` lets the fixed-position bar
// anchor to the viewport bottom.
const meta = {
  title: "Settings/MCP/McpBatchActionsBar",
  component: McpBatchActionsBar,
  parameters: { layout: "fullscreen" },
  args: { servers },
  beforeEach: () => {
    resetStore(useMcpPanelStore)
  },
  decorators: [
    (Story) => (
      <div className="h-[200px] w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpBatchActionsBar>

export default meta
type Story = StoryObj<typeof meta>

export const MultipleSelected: Story = {
  beforeEach: () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, {
      selection: new Set([servers[0].id, servers[1].id, servers[2].id]),
    })
  },
}

export const SingleSelected: Story = {
  beforeEach: () => {
    resetStore(useMcpPanelStore)
    seedStore(useMcpPanelStore, { selection: new Set([servers[0].id]) })
  },
}

// Empty selection → the bar collapses to nothing. Documents the hidden branch.
export const NoSelection: Story = {}
