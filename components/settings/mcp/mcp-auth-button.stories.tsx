import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpAuthButton } from "./mcp-auth-button"
import { makeMcpServer } from "@/lib/storybook/fixtures/settings-mcp"

// Props-only (`server`). Internally reads `useMcpOAuthStatus`, which resolves to
// the "none" (web) status without probing the keyring in the Storybook browser
// (isTauri() is false). stdio servers render nothing; remote servers show the
// status pill + Authenticate action.
const meta = {
  title: "Settings/MCP/McpAuthButton",
  component: McpAuthButton,
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpAuthButton>

export default meta
type Story = StoryObj<typeof meta>

export const RemoteHttp: Story = {
  args: {
    server: makeMcpServer({
      name: "github",
      transport: "http",
      config: { url: "https://api.githubcopilot.com/mcp/" },
    }),
  },
}

export const RemoteSse: Story = {
  args: {
    server: makeMcpServer({
      name: "linear",
      transport: "sse",
      config: { url: "https://mcp.linear.app/sse" },
    }),
  },
}

// stdio transport → component returns null (OAuth applies to remote only).
export const StdioRendersNothing: Story = {
  args: {
    server: makeMcpServer({ name: "filesystem", transport: "stdio" }),
  },
}
