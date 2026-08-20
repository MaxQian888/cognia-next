import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpServerRow } from "./mcp-server-row"
import { makeMcpServer } from "@/lib/storybook/fixtures/settings-mcp"

// Pure, props-only master-list row. Callbacks are spies; everything that needs
// the desktop shell lives in the detail pane, so this renders identically in
// the Storybook browser.
const stdioServer = makeMcpServer({
  id: "mcp_fs",
  name: "filesystem",
  transport: "stdio",
  config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"] },
  enabled: true,
})

const httpServer = makeMcpServer({
  id: "mcp_github",
  name: "github",
  transport: "http",
  config: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ••••" } },
  enabled: true,
})

const meta = {
  title: "Settings/MCP/McpServerRow",
  component: McpServerRow,
  args: {
    server: stdioServer,
    active: false,
    selected: false,
    favorite: false,
    density: "comfortable",
    onOpen: fn(),
    onToggleSelect: fn(),
    onToggleFavorite: fn(),
    onToggle: fn(),
    onEdit: fn(),
    onClone: fn(),
    onExport: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-xs border p-1.5">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpServerRow>

export default meta
type Story = StoryObj<typeof meta>

export const Comfortable: Story = {}

export const WithTools: Story = {
  args: { toolCount: 14, deniedToolCount: 3 },
}

export const ActiveFavorite: Story = {
  args: { active: true, favorite: true, selected: true },
}

export const Compact: Story = {
  args: { density: "compact" },
}

export const Disabled: Story = {
  args: { server: makeMcpServer({ ...stdioServer, enabled: false }) },
}

export const RemoteHttp: Story = {
  args: { server: httpServer, toolCount: 6 },
}
