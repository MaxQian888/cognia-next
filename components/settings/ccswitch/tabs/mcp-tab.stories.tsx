import type { Meta, StoryObj } from "@storybook/nextjs"

import { CcswitchMcpTab } from "./mcp-tab"

// CCSwitch → MCP tab: lists the MCP servers CCSwitch tracks. Tauri-backed;
// browser renders the desktop-only / empty state. No props.
const meta = {
  title: "Settings/CcSwitch/Tabs/McpTab",
  component: CcswitchMcpTab,
  parameters: { layout: "padded" },
} satisfies Meta<typeof CcswitchMcpTab>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
