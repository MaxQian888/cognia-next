import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { McpPicker } from "./mcp-picker"
import type { McpServer } from "@cognia/agent-config-types"

// `serversForTesting` bypasses the Dexie fetch so the picker renders
// deterministically. Two enabled servers + one disabled (greyed out, can't be
// toggled) exercise every server-row state.
const TS = Date.parse("2026-06-01T09:00:00.000Z")
const SERVERS: McpServer[] = [
  {
    id: "srv-github",
    name: "GitHub",
    transport: "http",
    config: { url: "https://mcp.github" },
    enabled: true,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: "srv-fs",
    name: "Filesystem",
    transport: "stdio",
    config: { command: "mcp-fs" },
    enabled: true,
    createdAt: TS,
    updatedAt: TS,
  },
  {
    id: "srv-legacy",
    name: "Legacy SSE",
    transport: "sse",
    config: { url: "https://legacy" },
    enabled: false,
    createdAt: TS,
    updatedAt: TS,
  },
]

// Multi-select for MCP servers with a "use default" vs "custom" radio. Empty
// array under "custom" means "explicitly disable MCP" — distinct from default.
const meta = {
  title: "Scheduler/PayloadEditors/McpPicker",
  component: McpPicker,
  parameters: { layout: "padded" },
  args: {
    onModeChange: fn(),
    onChange: fn(),
    testId: "mcp-picker",
    serversForTesting: SERVERS,
  },
} satisfies Meta<typeof McpPicker>

export default meta
type Story = StoryObj<typeof meta>

// Default mode → server list is hidden; resolveSendOptions picks the subset.
export const DefaultMode: Story = {
  args: { mode: "default", value: undefined },
}

// Custom mode with two servers checked.
export const CustomModeWithSelection: Story = {
  args: { mode: "custom", value: ["srv-github", "srv-fs"] },
}

// Custom mode but no servers configured at all.
export const CustomModeEmpty: Story = {
  args: { mode: "custom", value: [], serversForTesting: [] },
}

// Disabled (read-only) — radios and checkboxes are inert.
export const Disabled: Story = {
  args: { mode: "custom", value: ["srv-github"], disabled: true },
}
