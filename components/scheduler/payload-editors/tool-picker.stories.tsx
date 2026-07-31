import type { Meta, StoryObj } from "@storybook/nextjs"
import { fn } from "storybook/test"

import { ToolPicker } from "./tool-picker"

// Multi-select over the SDK built-in tool names plus free-typed custom tool
// names (e.g. MCP tools). Custom names appear as removable chips.
const meta = {
  title: "Scheduler/PayloadEditors/ToolPicker",
  component: ToolPicker,
  parameters: { layout: "padded" },
  args: {
    onChange: fn(),
    testId: "tool-picker",
  },
} satisfies Meta<typeof ToolPicker>

export default meta
type Story = StoryObj<typeof meta>

// Nothing selected → all built-in checkboxes unchecked, no custom chips.
export const Empty: Story = {
  args: { value: undefined },
}

// A subset of built-in tools checked.
export const WithBuiltins: Story = {
  args: { value: ["Read", "Edit", "Bash", "Grep"] },
}

// Built-ins plus custom (non-built-in) tool names rendered as removable chips.
export const WithCustomTools: Story = {
  args: {
    value: ["Read", "Write", "mcp__github__create_issue", "mcp__slack__post_message"],
  },
}

// Disabled (read-only) — checkboxes, chips, and the add field are inert.
export const Disabled: Story = {
  args: {
    value: ["Read", "mcp__github__create_issue"],
    disabled: true,
  },
}
