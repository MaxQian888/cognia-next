import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpAgentChipGroup } from "./mcp-agent-chip-group"
import type { McpServer } from "@/lib/claude/types"

// `McpAgentChipGroup` renders one chip per known external coding agent for a
// given MCP server, reflecting whether the server is projected into that agent's
// config (`appsEnabled[agentId]`). Agent availability comes from
// `useAgentStatuses`, which probes files through the Tauri runtime — in the
// browser preview the agents are non-writable/unavailable, so the chips render
// inert (the realistic web state).
const DEMO_SERVER = {
  id: "srv_demo01",
  name: "filesystem",
  transport: "stdio",
  config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
  enabled: true,
  appsEnabled: { "claude-code": true },
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as unknown as McpServer

const meta = {
  title: "Settings/McpAgentChipGroup",
  component: McpAgentChipGroup,
  parameters: { layout: "padded" },
  args: { server: DEMO_SERVER },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpAgentChipGroup>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
