import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpServerCard } from "./mcp-server-card"
import { makeMcpServer } from "@/lib/storybook/fixtures/settings-mcp"

// Pure, props-only tile. Callbacks are spies; the test/auth actions are
// desktop-only and resolve to no-ops in the Storybook browser (isTauri() is
// false). It renders the per-agent chip group + auth button children, both of
// which take their web/no-token branch here.
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
  title: "Settings/MCP/McpServerCard",
  component: McpServerCard,
  args: {
    server: stdioServer,
    selected: false,
    favorite: false,
    variant: "card",
    onToggleSelect: fn(),
    onToggleFavorite: fn(),
    onToggle: fn(),
    onEdit: fn(),
    onClone: fn(),
    onDelete: fn(),
  },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpServerCard>

export default meta
type Story = StoryObj<typeof meta>

export const Card: Story = {}

export const SelectedFavorite: Story = {
  args: { selected: true, favorite: true },
}

export const Disabled: Story = {
  args: { server: makeMcpServer({ ...stdioServer, enabled: false }) },
}

export const RemoteHttp: Story = {
  args: { server: httpServer },
}

export const Row: Story = {
  args: { variant: "row" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
}
