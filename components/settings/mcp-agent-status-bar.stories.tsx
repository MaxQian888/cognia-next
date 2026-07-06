import type { Meta, StoryObj } from "@storybook/nextjs"

import { McpAgentStatusBar } from "./mcp-agent-status-bar"

// `McpAgentStatusBar` lists external coding agents (Claude Code, Cursor, …) with
// their on-disk MCP file path + sync buttons. The agent files only exist in the
// desktop runtime, so `isTauri()` gates it: in the browser preview it returns
// `null`. Documented here so the dormant-in-web behaviour is discoverable.
const meta = {
  title: "Settings/McpAgentStatusBar",
  component: McpAgentStatusBar,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof McpAgentStatusBar>

export default meta
type Story = StoryObj<typeof meta>

// Web/preview branch: renders nothing. The per-agent rows appear only in the
// Tauri desktop build.
export const Default: Story = {}
