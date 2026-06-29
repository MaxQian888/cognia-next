import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpServerEditor } from "./mcp-server-editor"

// Pure create/edit form. `initial` seeds the form once at mount; `onSave` /
// `onCancel` are spies. Transport drives which config section renders.
const meta = {
  title: "Settings/MCP/McpServerEditor",
  component: McpServerEditor,
  args: {
    onCancel: fn(),
    onSave: fn(async () => {}),
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpServerEditor>

export default meta
type Story = StoryObj<typeof meta>

export const CreateStdio: Story = {
  args: {
    initial: {
      name: "",
      transport: "stdio",
      config: { command: "", args: [] },
      enabled: true,
      appsEnabled: {},
    },
  },
}

export const EditStdio: Story = {
  args: {
    initial: {
      name: "filesystem",
      transport: "stdio",
      config: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/work"],
        env: { LOG_LEVEL: "debug" },
      },
      enabled: true,
      appsEnabled: { "claude-code": true },
    },
  },
}

export const EditHttp: Story = {
  args: {
    initial: {
      name: "github",
      transport: "http",
      config: {
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ••••" },
      },
      enabled: true,
      appsEnabled: {},
    },
  },
}
