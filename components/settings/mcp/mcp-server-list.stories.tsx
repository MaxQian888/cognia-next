import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpServerList } from "./mcp-server-list"
import { makeMcpServerList } from "@/lib/storybook/fixtures/settings-mcp"

// Pure, props-only. Renders the grouped/sorted server cards or rows. Selection
// and favorites are passed in directly; callbacks are spies.
const servers = makeMcpServerList()

const meta = {
  title: "Settings/MCP/McpServerList",
  component: McpServerList,
  args: {
    servers,
    view: "grid",
    groupBy: "none",
    selection: new Set<string>(),
    isFavorite: (_id: string): boolean => false,
    onToggleSelect: fn(),
    onToggleFavorite: fn(),
    onToggle: fn(),
    onEdit: fn(),
    onClone: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-4xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpServerList>

export default meta
type Story = StoryObj<typeof meta>

export const Grid: Story = {}

export const ListView: Story = {
  args: { view: "list" },
}

export const GroupedByTransport: Story = {
  args: { groupBy: "transport" },
}

export const GroupedByStatus: Story = {
  args: { groupBy: "status" },
}

export const WithSelectionAndFavorite: Story = {
  args: {
    selection: new Set([servers[0].id]),
    isFavorite: (id: string) => id === servers[1].id,
  },
}
