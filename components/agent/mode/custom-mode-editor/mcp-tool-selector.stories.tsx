import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpToolSelector } from "./mcp-tool-selector"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useMcpStore, type McpServerStub } from "@/stores/mcp/mcp-store"

const SERVERS: McpServerStub[] = [
  {
    id: "fs",
    name: "Filesystem",
    status: { type: "connected" },
    tools: [
      { name: "read_file", description: "Read a file from disk" },
      { name: "write_file", description: "Write a file to disk" },
      { name: "list_dir", description: "List directory entries" },
    ],
  },
  {
    id: "gh",
    name: "GitHub",
    status: { type: "connected" },
    tools: [
      { name: "create_pr", description: "Open a pull request" },
      { name: "list_issues", description: "List repository issues" },
    ],
  },
]

const meta = {
  title: "Agent/Mode/CustomModeEditor/McpToolSelector",
  component: McpToolSelector,
  args: { value: [], onChange: fn() },
  beforeEach: () => {
    resetStore(useMcpStore)
  },
} satisfies Meta<typeof McpToolSelector>

export default meta
type Story = StoryObj<typeof meta>

// No connected MCP servers → empty-state message.
export const NoServers: Story = {}

export const WithServers: Story = {
  decorators: [
    (Story) => {
      seedStore(useMcpStore, { servers: SERVERS })
      return <Story />
    },
  ],
}

export const WithRecommendations: Story = {
  decorators: [
    (Story) => {
      seedStore(useMcpStore, { servers: SERVERS })
      return <Story />
    },
  ],
  args: {
    recommendationContext: {
      name: "Repo maintainer",
      description: "Reviews PRs and triages issues",
      systemPrompt: "You manage GitHub pull requests and read files for context.",
      category: "technical",
    },
  },
}
